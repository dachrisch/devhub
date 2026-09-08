import {
  assignIssue,
  getIssue,
  getIssuesByTopic,
  getProject,
  getTopic,
  refreshTopicStatus,
  setBlockedReason,
  updateTopic,
  upsertIssue,
} from './store';
import { canDevelop, startWork } from './develop';
import { createGithubIssue, sweepRollouts } from './github';
import { publishIssue, publishTopic } from './sse';
import { ENV } from './env';
import type { OpencodeModel } from './opencode';
import type { Issue, Topic } from './types';

// One-click Realize (devhub#171 Phase 3): single entry chaining
// promote → startWork → sweep wait. The route returns 202 immediately;
// this core runs fire-and-forget and the idea page follows progress via the
// existing `issue`/`run`/`topic` SSE events. The user intervenes only on
// `blocked_reason` or failed checks.

export type RealizeStage = 'understanding' | 'building' | 'checking' | 'delivered' | 'needs-input';

export const REALIZE_STAGE_LABELS: Record<RealizeStage, string> = {
  understanding: 'Understanding…',
  building: 'Building…',
  checking: 'Checking…',
  delivered: 'Delivered',
  'needs-input': 'Needs input',
};

// Plain-words timeline derived from the hidden execution layer. Mirrored by a
// client-safe copy on the idea page (which cannot import this server module).
export function realizeStage(topicStatus: Topic['status'], issues: Issue[]): RealizeStage {
  if (topicStatus === 'shipped' || (issues.length > 0 && issues.every((i) => i.state === 'rollout' || i.state === 'closed'))) {
    return 'delivered';
  }
  if (issues.some((i) => i.blockedReason)) return 'needs-input';
  if (issues.some((i) => i.state === 'pr')) return 'checking';
  if (issues.some((i) => i.state === 'developing')) return 'building';
  return 'understanding';
}

export type RealizeAction = 'full' | 'wait-only' | 'done';
export type RealizeDecision =
  | { ok: true; action: RealizeAction }
  | { ok: false; error: string; status: 400 | 409 };

// Guard: never re-realize `realizing` with a live run (`canDevelop` + topic
// status check); retry touches only failed runs. Pure for testability —
// callers pass a fresh read of the topic, its linked issues, and whether a
// realize loop is already live for it.
export function canRealize(
  topic: Topic,
  issues: Issue[],
  live: boolean
): RealizeDecision {
  if (topic.status === 'dropped') return { ok: false, error: 'idea is archived', status: 400 };
  if (topic.status === 'shipped') return { ok: false, error: 'idea is already delivered', status: 400 };
  if (live) return { ok: false, error: 'realization already running', status: 409 };
  const settled = issues.length > 0 && issues.every((i) => i.state === 'rollout' || i.state === 'closed');
  if (settled) return { ok: true, action: 'done' };
  const blocked = issues.some((i) => i.blockedReason);
  if (blocked) return { ok: true, action: 'full' };
  const liveWork = issues.some((i) => i.state === 'developing' || i.state === 'pr');
  if (topic.status === 'realizing' && liveWork) return { ok: true, action: 'wait-only' };
  if (issues.some((i) => canDevelop(i))) return { ok: true, action: 'full' };
  if (liveWork) return { ok: true, action: 'wait-only' };
  return { ok: true, action: 'full' };
}

// One realize loop per topic; a second click while the loop runs gets a 409
// instead of a duplicate chain (same rule as liveShapingRuns).
const liveRealizeRuns = new Set<number>();

export function isRealizeLive(topicId: number): boolean {
  return liveRealizeRuns.has(topicId);
}

export interface RealizeOptions {
  command?: string;
  selectedModel?: OpencodeModel | null;
  waitTimeoutMs?: number;
}

export type RealizeOutcome =
  | { mode: 'delivered' }
  | { mode: 'needs-input' }
  | { mode: 'timed-out' }
  | { mode: 'already-running' }
  | { mode: 'gone' };

const POLL_MS = 15_000;
const SWEEP_EVERY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function realizeTopic(
  topicId: number,
  token: string,
  opts: RealizeOptions = {}
): Promise<RealizeOutcome> {
  const topic = getTopic(topicId);
  if (!topic) return { mode: 'gone' };
  const decision = canRealize(topic, getIssuesByTopic(topicId), isRealizeLive(topicId));
  if (!decision.ok) return { mode: 'already-running' };
  if (decision.action === 'done') {
    refreshTopicStatus(topicId);
    publishTopic(topicId);
    return { mode: 'delivered' };
  }
  if (isRealizeLive(topicId)) return { mode: 'already-running' };
  liveRealizeRuns.add(topicId);
  try {
    // Promote first when the idea has no linked issue yet (same contract as
    // POST /api/topics/[id]/promote: always creates the GitHub issue).
    let issues = getIssuesByTopic(topicId);
    if (issues.length === 0) {
      await promoteTopicForRealize(topic, token);
      issues = getIssuesByTopic(topicId);
    }
    const issue = issues.find((i) => canDevelop(i)) ?? issues[0];
    if (issue && decision.action === 'full' && canDevelop(getIssue(issue.id) ?? issue)) {
      // Await the Work chain (refinement → develop → PR) before the sweep
      // wait so failures surface here with the run's blocked_reason intact.
      await startWork(getIssue(issue.id) ?? issue, opts.command ?? '', token, opts.selectedModel ?? null);
    }
    return await waitForRealization(topicId, token, opts.waitTimeoutMs ?? ENV.realizeWaitTimeoutMs);
  } finally {
    liveRealizeRuns.delete(topicId);
  }
}

// Watches the sweep (source of truth for rollout/shipped) until the topic
// ships, something needs input, or the budget runs out.
async function waitForRealization(topicId: number, token: string, budgetMs: number): Promise<RealizeOutcome> {
  const deadline = Date.now() + budgetMs;
  let lastSweep = 0;
  for (;;) {
    const topic = getTopic(topicId);
    if (!topic) return { mode: 'gone' };
    if (topic.status === 'shipped') return { mode: 'delivered' };
    const issues = getIssuesByTopic(topicId);
    if (issues.length > 0 && issues.every((i) => i.state === 'rollout' || i.state === 'closed')) {
      refreshTopicStatus(topicId);
      publishTopic(topicId);
      return { mode: 'delivered' };
    }
    if (issues.some((i) => i.blockedReason)) {
      publishTopic(topicId);
      return { mode: 'needs-input' };
    }
    if (Date.now() - lastSweep >= SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      try {
        await sweepRollouts(token);
      } catch {
        // transient GitHub failure: the next pass retries
      }
    }
    if (Date.now() >= deadline) {
      const pending = issues.find((i) => i.state !== 'rollout' && i.state !== 'closed');
      if (pending) {
        const updated = setBlockedReason(
          pending.id,
          'Realize timed out waiting for checks/merge — open the PR, merge when green, then click Realize to resume.'
        );
        if (updated) publishIssue(updated);
      }
      publishTopic(topicId);
      return { mode: 'timed-out' };
    }
    await sleep(POLL_MS);
  }
}

async function promoteTopicForRealize(topic: Topic, token: string): Promise<void> {
  const project = topic.projectId != null ? getProject(topic.projectId) : null;
  const owner = project?.serviceRepoOwner;
  const repo = project?.serviceRepoName;
  if (!owner || !repo) {
    throw new Error('topic has no service repo (assign it to a project first)');
  }
  const title = topic.title;
  const issueBody =
    [topic.notes, topic.shapedSummary ? `Shaped: ${topic.shapedSummary}` : null, topic.area ? `Area: ${topic.area}` : null]
      .filter(Boolean)
      .join('\n\n') || null;
  const created = await createGithubIssue(owner, repo, title, issueBody, token);
  const stored = upsertIssue({
    githubIssueId: 0,
    owner,
    repo,
    number: created.number,
    title,
    body: issueBody,
    htmlUrl: created.htmlUrl,
  });
  const withLinks = assignIssue(stored.id, { projectId: project!.id, topicId: topic.id });
  if (withLinks) publishIssue(withLinks);
  updateTopic(topic.id, { status: 'realizing' });
  refreshTopicStatus(topic.id);
  publishTopic(topic.id);
}
