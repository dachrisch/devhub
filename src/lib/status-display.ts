// Unified status display layer: derives a FunnelColumn + label for issues
// and topics so every page shows the same vocabulary the board uses.
// Reuses the existing funnel derivation — no new mapping logic.

import type { IssueState, TopicStatus } from './types';
import { FUNNEL_STAGE_LABELS, funnelColumnForIssue, funnelColumnForTopicWithIssues } from './funnel';
import type { FunnelColumn } from './funnel';

export interface DisplayStatus {
  key: FunnelColumn;
  label: string;
}

// An issue's display status reuses the board's own column derivation, so
// the detail-page pill matches the kanban column the card sits in.
export function deriveIssueDisplayStatus(state: IssueState): DisplayStatus {
  const key = funnelColumnForIssue(state);
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return { key, label };
}

// A topic's display status keeps the pill consistent with the board column
// the topic card occupies. The label always follows the derived column —
// "Ready" for queued work, "Building…" once started — so a realizing topic
// with only queued work never claims to be building from the ready column.
export function deriveTopicDisplayStatus(
  status: TopicStatus,
  issueStates: IssueState[] = [],
): DisplayStatus {
  const key = funnelColumnForTopicWithIssues(status, issueStates);
  if (key === 'delivered') {
    return { key, label: status === 'dropped' ? 'Archived' : 'Delivered' };
  }
  if (key === 'idea') {
    return { key, label: status === 'new' ? 'New idea' : 'Shaping…' };
  }
  return { key, label: FUNNEL_STAGE_LABELS[key] };
}
