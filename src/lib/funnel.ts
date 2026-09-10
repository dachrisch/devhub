import type { IssueState, TopicStatus } from './types';

// Unified-funnel columns for the project board (2026-09-09 redesign). The
// topic/issue seam never shows: ideas are the first column, ready merges
// topic-ready with issue-backlog, realizing merges refinement with
// developing, rollout holds open PRs awaiting release, and delivered (closed
// + rollout issues, shipped/dropped topics) renders as a collapsed muted
// section, not a column. A rollout card is terminal shipped work — keeping it
// in a live column would pile finished cards up forever, so it retires to
// delivered history automatically (the release tag stays on the row).
export type FunnelColumn = 'idea' | 'ready' | 'realizing' | 'rollout' | 'delivered';

// The four live kanban columns, in display order. Delivered is intentionally
// absent: it renders below the board, collapsed and muted.
export const FUNNEL_COLUMNS: readonly FunnelColumn[] = ['idea', 'ready', 'realizing', 'rollout'];

export const FUNNEL_LABELS: Record<FunnelColumn, string> = {
  idea: 'idea',
  ready: 'ready',
  realizing: 'realizing',
  rollout: 'rollout',
  delivered: 'delivered',
};

// A topic with no linked work yet maps by status alone. A `realizing` topic
// whose issues are all still backlog reads as `ready` — the issue list is
// the source of truth once linked (see funnelColumnForTopicWithIssues).
export function funnelColumnForTopic(status: TopicStatus): FunnelColumn {
  switch (status) {
    case 'new':
    case 'shaping':
      return 'idea';
    case 'ready':
    case 'realizing':
      return 'ready';
    case 'shipped':
    case 'dropped':
      return 'delivered';
  }
}

// Refines the topic mapping with its linked issues: work that started moves
// the topic to `realizing`, settled work (closed or shipped/rollout) to
// `delivered`. Backlog-only (or no) issues leave the status-derived column
// untouched. Terminal topic statuses always win: a shipped/dropped idea stays
// delivered even while a linked issue is still tracked in its own column.
export function funnelColumnForTopicWithIssues(
  status: TopicStatus,
  issueStates: IssueState[]
): FunnelColumn {
  if (status === 'shipped' || status === 'dropped') return 'delivered';
  if (issueStates.length === 0) return funnelColumnForTopic(status);
  if (issueStates.every((s) => s === 'closed' || s === 'rollout')) return 'delivered';
  if (issueStates.some((s) => s === 'refinement' || s === 'developing' || s === 'pr')) {
    return 'realizing';
  }
  return funnelColumnForTopic(status);
}

export function funnelColumnForIssue(state: IssueState): FunnelColumn {
  switch (state) {
    case 'backlog':
      return 'ready';
    case 'refinement':
    case 'developing':
      return 'realizing';
    case 'pr':
      return 'rollout';
    case 'rollout':
    case 'closed':
      return 'delivered';
  }
}
