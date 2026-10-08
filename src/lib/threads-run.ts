import {
  appendThreadEvent,
  createThread,
  getGithubIssues,
  getThread,
  getThreadEvents,
  updateThread,
} from './store';
import type { Thread } from './types';
import { buildContextBrief, buildPlannerPrompt, capSplitProposal, parseSplitProposal, type SplitItem } from './plan';
import { ENV } from './env';
import { getAvailableModels, resolveModels, runDevelop, sanitizeModels, type OpencodeModel } from './opencode';
import { canDevelop, startWork } from './develop';
import { getIssue } from './store';
import { publishThread, publishThreadEvent } from './sse';

// A stalled thread records its reason as a `blocked:`-prefixed system event —
// the same resume pattern as Work's blocked_reason, without a new column.
const BLOCKED_PREFIX = 'blocked: ';

export function getThreadBlockedReason(threadId: number): string | null {
  const events = getThreadEvents(threadId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'system' && e.text.startsWith(BLOCKED_PREFIX)) {
      return e.text.slice(BLOCKED_PREFIX.length);
    }
  }
  return null;
}

export function markThreadBlocked(threadId: number, reason: string): Thread | null {
  appendThreadEvent(threadId, 'system', `${BLOCKED_PREFIX}${reason}`);
  publishThreadEvent(threadId);
  const updated = updateThread(threadId, { state: 'blocked' });
  if (updated) publishThread(updated.id);
  return updated;
}

// Records one planner turn on the thread and extracts any split proposal.
// Empty output blocks the thread (reply-from-detail resumes it).
export function recordPlannerTurn(threadId: number, text: string): SplitItem[] {
  if (!text.trim()) {
    markThreadBlocked(threadId, 'planner yielded no strategy — reply to resume');
    return [];
  }
  appendThreadEvent(threadId, 'agent', text);
  publishThreadEvent(threadId);
  return parseSplitProposal(text);
}

// Split proposals arrive on the last thread_event — recover the latest one
// for the confirm gate. Empty when the planner never proposed a split.
export function getLatestSplitProposal(threadId: number): SplitItem[] {
  const events = getThreadEvents(threadId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== 'agent') continue;
    const items = parseSplitProposal(events[i].text);
    if (items.length > 0) return items;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Serial work queue: confirmed split cards enter auto-Work one developing run
// at a time; the card shows its visible queue position.
// ---------------------------------------------------------------------------

let workQueue: number[] = [];
let liveWorkIssueId: number | null = null;

export type WorkRunner = (issueId: number) => Promise<void>;
let workRunner: WorkRunner | null = null;

export function setWorkRunner(runner: WorkRunner | null): void {
  workRunner = runner;
}

export function resetQueueForTests(): void {
  workQueue = [];
  liveWorkIssueId = null;
  workRunner = null;
}

// Enqueues issue ids, skipping ids already queued/live. Returns 1-based
// positions in enqueue order.
export function enqueueWork(issueIds: number[]): number[] {
  const positions: number[] = [];
  for (const id of issueIds) {
    if (id === liveWorkIssueId || workQueue.includes(id)) {
      positions.push(getQueuePosition(id) as number);
      continue;
    }
    workQueue.push(id);
    positions.push(workQueue.length + (liveWorkIssueId != null ? 1 : 0));
  }
  return positions;
}

// 1-based position ('live' while its run is in flight, null when not queued).
export function getQueuePosition(issueId: number): number | 'live' | null {
  if (issueId === liveWorkIssueId) return 'live';
  const idx = workQueue.indexOf(issueId);
  if (idx === -1) return null;
  return idx + 1 + (liveWorkIssueId != null ? 1 : 0);
}

// Starts queued runs when none is live and drains the queue one run at a
// time. Failures never stall the queue — the card keeps its blocked_reason
// and the next item proceeds. Re-entrant pumps while a drain is in flight
// are no-ops (the live flag guards them).
export async function pumpWorkQueue(): Promise<void> {
  if (liveWorkIssueId != null || !workRunner) return;
  while (workQueue.length > 0) {
    if (liveWorkIssueId != null) return;
    const next = workQueue.shift()!;
    liveWorkIssueId = next;
    try {
      await workRunner(next);
    } catch {
      // The runner surfaces failures on the card; the queue moves on.
    } finally {
      liveWorkIssueId = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Thread entry points (fire-and-forget from API routes)
// ---------------------------------------------------------------------------

export interface ThreadCommand {
  text: string;
  token: string;
  model?: OpencodeModel | null;
}

// Work thread: card appears at top in `refining`, then delegates to the
// existing #132 flow (refinement check → develop) — no new develop logic.
export async function startWorkThread(thread: Thread, issueId: number, command: ThreadCommand): Promise<void> {
  const issue = getIssue(issueId);
  if (!issue) {
    markThreadBlocked(thread.id, 'linked issue not found');
    return;
  }
  updateThread(thread.id, { issueIds: [issueId] });
  appendThreadEvent(thread.id, 'user', command.text);
  await startWork(issue, command.text, command.token, command.model ?? null);
}

// Strategy thread: context brief + planner run at ~2× the refinement poll
// budget. Streams into the detail view; split proposals wait for confirm.
export async function startStrategyThread(
  thread: Thread,
  targets: string[],
  command: ThreadCommand
): Promise<void> {
  appendThreadEvent(thread.id, 'user', command.text);
  const issues = getGithubIssues().filter((i) => targets.includes(`${i.owner}/${i.repo}`));
  const brief = buildContextBrief(issues);
  const prompt = buildPlannerPrompt(brief, command.text);
  const models = sanitizeModels(resolveModels(command.model ?? null), await getAvailableModels());
  updateThread(thread.id, { state: 'planning' });
  try {
    const text = await runDevelop(
      prompt,
      (event) => {
        appendThreadEvent(thread.id, 'agent', JSON.stringify(event));
        publishThreadEvent(thread.id);
      },
      models,
      (sessionId) => {
        const updated = updateThread(thread.id, { sessionId });
        if (updated) publishThread(updated.id);
      },
      ENV.opencodeRefinementPollTimeoutMs * 2
    );
    recordPlannerTurn(thread.id, text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    markThreadBlocked(thread.id, `planner failed: ${reason}`);
  }
}

// Reply resumes the run from the detail view (same pattern as Work resume).
export async function replyToThread(thread: Thread, text: string, command: ThreadCommand): Promise<void> {
  appendThreadEvent(thread.id, 'user', text);
  publishThreadEvent(thread.id);
  updateThread(thread.id, { state: thread.kind === 'strategy' ? 'planning' : 'refining' });
  if (thread.kind === 'strategy') {
    const targets = [...new Set(getGithubIssues().filter((i) => thread.issueIds.includes(i.id)).map((i) => `${i.owner}/${i.repo}`))];
    await startStrategyThread(thread, targets, { ...command, text });
    return;
  }
  const issueId = thread.issueIds[0];
  const issue = issueId != null ? getIssue(issueId) : null;
  if (!issue || !canDevelop(issue)) {
    markThreadBlocked(thread.id, 'nothing resumable — pick a work item');
    return;
  }
  await startWork(issue, text, command.token, command.model ?? null);
}

export interface SplitConfirmer {
  createIssue: (item: SplitItem) => Promise<number>;
}

// Split confirm gate: nothing is created until confirm. Confirmed cards become
// real issue ids (created by the caller-provided confirmer, topic-tagged so
// sync already finds them) and enter the serial auto-Work queue.
export async function confirmSplit(
  threadId: number,
  items: SplitItem[],
  confirmer: SplitConfirmer
): Promise<number[]> {
  const { kept, capped, offered } = capSplitProposal(items);
  const ids: number[] = [];
  for (const item of kept) {
    ids.push(await confirmer.createIssue(item));
  }
  const thread = getThread(threadId);
  const lines = kept.map((k, i) => `- ${k.title} (issue ${ids[i]})`).join('\n');
  appendThreadEvent(
    threadId,
    'system',
    `split confirmed: ${ids.length} card${ids.length === 1 ? '' : 's'} queued${capped ? ` (capped from ${offered} — the rest offered as follow-up)` : ''}\n${lines}`
  );
  const updated = updateThread(threadId, { state: 'done', issueIds: [...(thread?.issueIds ?? []), ...ids] });
  if (updated) publishThread(updated.id);
  publishThreadEvent(threadId);
  enqueueWork(ids);
  void pumpWorkQueue();
  return ids;
}

export { createThread };
