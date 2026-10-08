import type { Issue, Thread } from './types';

// Pure work-item card shaping shared by the board. The React renderer lives in
// components/threads/work-card.tsx; keeping the logic here makes it unit
// testable without a DOM/JSX runtime.

export interface CardItem {
  key: string;
  title: string;
  repo: string;
  statusLabel: string;
  statusKey: string;
  blockedReason: string | null;
  queuePosition: number | 'live' | null;
  threadId: number | null;
  issueId: number | null;
  commandMention: string;
  active: boolean;
  /** A run is in flight right now (not blocked/terminal). */
  working: boolean;
  /** Terminal detail for the closed strip (e.g. not_planned → "not planned"). */
  note: string | null;
  /** GitHub issues linked to this work (0 for a free-text request). */
  issueCount: number;
  /** Distinct pull requests produced by this work (0 before any PR). */
  prCount: number;
}

// Serial-queue position per work-item id ('live' while its run is in flight).
export type QueuePositions = Record<number, number | 'live'>;

// Issue states that mean a run is live.
const WORKING_STATES = new Set(['refining', 'planning', 'developing', 'refinement']);

function isWorking(statusKey: string): boolean {
  return WORKING_STATES.has(statusKey);
}

function countPrs(issues: Issue[]): number {
  const urls = new Set<string>();
  for (const i of issues) {
    if (i.resultPrUrl) urls.add(i.resultPrUrl);
    if (i.linkedPrUrl) urls.add(i.linkedPrUrl);
  }
  return urls.size;
}

export function cardForThread(thread: Thread, issues: Issue[], queuePositions: QueuePositions = {}): CardItem {
  const linked = thread.issueIds
    .map((id) => issues.find((i) => i.id === id))
    .filter((i): i is Issue => Boolean(i));
  const blocked =
    linked.find((i) => i.blockedReason)?.blockedReason ?? null;
  const githubLinked = linked.filter((i) => i.source !== 'request');
  const repo =
    linked.length > 0
      ? [...new Set(linked.map((i) => `${i.owner}/${i.repo}`))].join(', ')
      : thread.kind === 'strategy'
        ? 'strategy'
        : 'work';
  const anchor = linked[0];
  const requestAnchor = anchor?.source === 'request';
  // A work thread's lifecycle is the issue's lifecycle — thread.state only
  // tracks the command/thread stage (and stays `refining` for work threads).
  // Show the linked work item's state so the card matches the pipeline.
  const statusKey = thread.kind === 'strategy' ? thread.state : anchor?.state ?? thread.state;
  const statusLabel = thread.kind === 'strategy' ? `planning · ${thread.state}` : statusKey;
  const queued = linked.find((i) => queuePositions[i.id] != null);
  return {
    key: `thread-${thread.id}`,
    // The command ("Implement owner/repo#123") is not the work item's title —
    // prefer the linked issue's real title so the card reads like the detail.
    title: thread.kind === 'work' ? anchor?.title ?? thread.title : thread.title,
    repo,
    statusLabel,
    statusKey,
    blockedReason: blocked,
    queuePosition: queued ? queuePositions[queued.id] : null,
    threadId: thread.id,
    issueId: anchor && !requestAnchor ? anchor.id : null,
    commandMention: anchor
      ? requestAnchor
        ? `Implement ${anchor.owner}/${anchor.repo}`
        : `Work on ${anchor.owner}/${anchor.repo}#${anchor.number}`
      : thread.title,
    note: linked.find((i) => i.state === 'closed')?.stateReason ?? null,
    active: thread.state !== 'done',
    working: !blocked && isWorking(statusKey),
    issueCount: githubLinked.length,
    prCount: countPrs(linked),
  };
}

export function cardForIssue(issue: Issue, queuePositions: QueuePositions = {}): CardItem {
  return {
    key: `issue-${issue.id}`,
    title: issue.title,
    repo: `${issue.owner}/${issue.repo} #${issue.number}`,
    statusLabel: issue.state,
    statusKey: issue.state,
    blockedReason: issue.blockedReason,
    queuePosition: queuePositions[issue.id] ?? null,
    threadId: null,
    issueId: issue.id,
    commandMention: `Implement ${issue.owner}/${issue.repo}#${issue.number}`,
    note: issue.stateReason,
    active: issue.state !== 'rollout' && issue.state !== 'closed',
    working: !issue.blockedReason && isWorking(issue.state),
    issueCount: issue.source === 'request' ? 0 : 1,
    prCount: countPrs([issue]),
  };
}

const RANK: Record<string, number> = {
  blocked: 0,
  refining: 1,
  planning: 1,
  developing: 2,
  ready: 3,
  pr: 4,
  backlog: 5,
  refinement: 5,
};

// Needs-input first (0), then live runs (1), then the rest by pipeline stage.
export function cardRank(card: CardItem): number {
  if (card.blockedReason) return 0;
  if (card.working) return 1;
  return RANK[card.statusKey] ?? 6;
}
