'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { closedReasonLabel, relTime } from '@/lib/board-ui';

// Released tickets are shown in a slim strip under the header, capped so the
// strip stays compact.
const RELEASED_CAP = 5;

// Similarly-capped strip for issues reconciled to the `closed` terminal state
// (closed on GitHub outside DevHub's own pipeline).
const CLOSED_CAP = 5;

export function RecentlyReleased({ issues }: { issues: Issue[] }) {
  const [expanded, setExpanded] = useState(false);
  const rolled = issues
    .filter((i) => i.state === 'rollout')
    .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''));
  if (rolled.length === 0) return null;
  const visible = expanded ? rolled : rolled.slice(0, RELEASED_CAP);
  return (
    <div className="released-strip">
      <span className="released-label">Released</span>
      <div className="released-list">
        {visible.map((issue) => (
          <Link key={issue.id} href={`/issues/${issue.id}`} className="released-item">
            <span className="released-tag">{issue.releaseTag ?? '?'}</span>
            <span className="released-title">
              {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
            </span>
            <span className="released-time">{relTime(issue.releasedAt ?? issue.updatedAt)}</span>
          </Link>
        ))}
      </div>
      {rolled.length > RELEASED_CAP && (
        <button className="released-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse' : `+${rolled.length - RELEASED_CAP} more`}
        </button>
      )}
    </div>
  );
}

export function RecentlyClosed({ issues }: { issues: Issue[] }) {
  const [expanded, setExpanded] = useState(false);
  const closed = issues
    .filter((i) => i.state === 'closed')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  if (closed.length === 0) return null;
  const visible = expanded ? closed : closed.slice(0, CLOSED_CAP);
  return (
    <div className="closed-strip">
      <span className="released-label">Closed</span>
      <div className="released-list">
        {visible.map((issue) => (
          <Link key={issue.id} href={`/issues/${issue.id}`} className="released-item">
            <span className="released-tag">{closedReasonLabel(issue.stateReason)}</span>
            <span className="released-title">
              {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
            </span>
            <span className="released-time">{relTime(issue.updatedAt)}</span>
          </Link>
        ))}
      </div>
      {closed.length > CLOSED_CAP && (
        <button className="released-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse' : `+${closed.length - CLOSED_CAP} more`}
        </button>
      )}
    </div>
  );
}
