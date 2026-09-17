// Unified status display layer: derives a FunnelColumn + label for issues
// and topics so every page shows the same vocabulary the board uses.
// Reuses the existing funnel derivation — no new mapping logic.

import type { IssueState, TopicStatus } from './types';
import { TOPIC_STATUS_LABELS } from './types';
import { funnelColumnForIssue, funnelColumnForTopicWithIssues } from './funnel';
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

// A topic's display status uses TOPIC_STATUS_LABELS for the plain-language
// copy but funnel-derives the tone, keeping the pill consistent with the
// board column the topic card occupies.
export function deriveTopicDisplayStatus(
  status: TopicStatus,
  issueStates: IssueState[] = [],
): DisplayStatus {
  const key = funnelColumnForTopicWithIssues(status, issueStates);
  const label = TOPIC_STATUS_LABELS[status] ?? status;
  return { key, label };
}
