'use client';

import type { Issue, Thread } from '@/lib/types';

// Work-item card (single column, active first): title, repo, status chip. A
// Needs-input banner is first-class card UI when blocked_reason is set —
// answering it from the phone is the primary loop.

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
  /** Terminal detail for the closed strip (e.g. not_planned → "not planned"). */
  note: string | null;
  /** GitHub issues linked to this work (0 for a free-text request). */
  issueCount: number;
  /** Distinct pull requests produced by this work (0 before any PR). */
  prCount: number;
}

function countPrs(issues: Issue[]): number {
  const urls = new Set<string>();
  for (const i of issues) {
    if (i.resultPrUrl) urls.add(i.resultPrUrl);
    if (i.linkedPrUrl) urls.add(i.linkedPrUrl);
  }
  return urls.size;
}

export function cardForThread(thread: Thread, issues: Issue[]): CardItem {
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
  return {
    key: `thread-${thread.id}`,
    title: thread.title,
    repo,
    statusLabel,
    statusKey,
    blockedReason: blocked,
    queuePosition: null,
    threadId: thread.id,
    issueId: anchor && !requestAnchor ? anchor.id : null,
    commandMention: anchor
      ? requestAnchor
        ? `Implement ${anchor.owner}/${anchor.repo}`
        : `Work on ${anchor.owner}/${anchor.repo}#${anchor.number}`
      : thread.title,
    note: linked.find((i) => i.state === 'closed')?.stateReason ?? null,
    active: thread.state !== 'done',
    issueCount: githubLinked.length,
    prCount: countPrs(linked),
  };
}

export function cardForIssue(issue: Issue): CardItem {
  return {
    key: `issue-${issue.id}`,
    title: `${issue.title}`,
    repo: `${issue.owner}/${issue.repo} #${issue.number}`,
    statusLabel: issue.state,
    statusKey: issue.state,
    blockedReason: issue.blockedReason,
    queuePosition: null,
    threadId: null,
    issueId: issue.id,
    commandMention: `Implement ${issue.owner}/${issue.repo}#${issue.number}`,
    note: issue.stateReason,
    active: issue.state !== 'rollout' && issue.state !== 'closed',
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

export function cardRank(card: CardItem): number {
  if (card.blockedReason) return 0;
  return RANK[card.statusKey] ?? 6;
}

interface WorkCardProps {
  card: CardItem;
  onOpen: () => void;
  onCommandOn: () => void;
}

export function WorkCard({ card, onOpen, onCommandOn }: WorkCardProps) {
  return (
    <article className="card v2-card" data-card={card.key}>
      <div className="v2-card-top">
        <button type="button" className="v2-card-main" onClick={onOpen} aria-label={`Open ${card.title}`}>
          <span className="v2-card-title">{card.title}</span>
          <span className="v2-card-repo">{card.repo}</span>
          <span className="v2-card-counts">
            work ({card.issueCount}) - ({card.prCount})
          </span>
        </button>
        <span className={`v2-chip v2-chip-${card.statusKey}`}>{card.statusLabel}</span>
      </div>
      {card.queuePosition != null && (
        <div className="v2-queue" role="status">
          {card.queuePosition === 'live' ? '● working now' : `queued #${card.queuePosition}`}
        </div>
      )}
      {card.blockedReason && (
        <div className="card-blocked v2-needs-input" role="alert">
          <strong>Needs input</strong>
          <span>{card.blockedReason.slice(0, 300)}</span>
        </div>
      )}
      <div className="v2-card-actions">
        <button type="button" className="ghost" onClick={onCommandOn} aria-label={`Prepare command for ${card.title}`}>
          Work on this
        </button>
      </div>
    </article>
  );
}
