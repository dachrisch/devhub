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
}

export function cardForThread(thread: Thread, issues: Issue[]): CardItem {
  const linked = thread.issueIds
    .map((id) => issues.find((i) => i.id === id))
    .filter((i): i is Issue => Boolean(i));
  const blocked =
    linked.find((i) => i.blockedReason)?.blockedReason ?? null;
  const repo =
    linked.length > 0
      ? [...new Set(linked.map((i) => `${i.owner}/${i.repo}`))].join(', ')
      : 'strategy';
  const statusLabel = thread.kind === 'strategy' ? `planning · ${thread.state}` : thread.state;
  return {
    key: `thread-${thread.id}`,
    title: thread.title,
    repo,
    statusLabel,
    statusKey: thread.state,
    blockedReason: blocked,
    queuePosition: null,
    threadId: thread.id,
    issueId: linked[0]?.id ?? null,
    commandMention: linked[0] ? `Work on ${linked[0].owner}/${linked[0].repo}#${linked[0].number}` : thread.title,
    active: thread.state !== 'done',
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
    active: issue.state !== 'rollout' && issue.state !== 'closed',
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
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onCommandOn: () => void;
}

export function WorkCard({ card, selected, onToggleSelect, onOpen, onCommandOn }: WorkCardProps) {
  return (
    <article className={`card v2-card${selected ? ' v2-card-selected' : ''}`} data-card={card.key}>
      <div className="v2-card-top">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${card.title}`}
          className="v2-card-check"
        />
        <button type="button" className="v2-card-main" onClick={onOpen} aria-label={`Open ${card.title}`}>
          <span className="v2-card-title">{card.title}</span>
          <span className="v2-card-repo">{card.repo}</span>
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
        <button type="button" className="ghost" onClick={onCommandOn}>
          Command on
        </button>
      </div>
    </article>
  );
}
