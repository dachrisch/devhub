'use client';

import type { FunnelColumn } from '@/lib/funnel';
import { deriveIssueDisplayStatus, deriveTopicDisplayStatus } from '@/lib/status-display';
import type { IssueState, TopicStatus } from '@/lib/types';

interface StatusPillProps {
  /** Provide a FunnelColumn key + label directly (e.g. from project health). */
  status?: { key: FunnelColumn; label: string };
  /** Or derive from an issue state. */
  issueState?: IssueState;
  /** Or derive from a topic status + linked issue states. */
  topicStatus?: TopicStatus;
  topicIssueStates?: IssueState[];
  className?: string;
}

export function StatusPill({
  status: directStatus,
  issueState,
  topicStatus,
  topicIssueStates,
  className = '',
}: StatusPillProps) {
  const resolved =
    directStatus ??
    (issueState != null
      ? deriveIssueDisplayStatus(issueState)
      : topicStatus != null
        ? deriveTopicDisplayStatus(topicStatus, topicIssueStates)
        : null);

  if (!resolved) return null;

  return (
    <span className={`status-pill status-pill--${resolved.key} ${className}`.trim()}>
      {resolved.label}
    </span>
  );
}
