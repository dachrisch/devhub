'use client';

import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { excerpt, primaryCardAction, relTime } from '@/lib/board-ui';

interface MobileCardProps {
  issue: Issue;
  color: string;
  busy: boolean;
  // A run started from this client whose server-side state hasn't arrived via
  // SSE yet: the card must show live/recap affordances, never the Work button.
  justStarted?: boolean;
  onPrimaryAction: () => void;
  onOpenActions: () => void;
}

export function MobileCard({ issue, color, busy, justStarted = false, onPrimaryAction, onOpenActions }: MobileCardProps) {
  const live = justStarted || (issue.state === 'developing' && !issue.blockedReason);
  const primary = primaryCardAction(issue, live);

  return (
    <div className="mobile-card">
      <div className="mobile-card-strip" style={{ background: `${color}22` }}>
        <span className="mobile-card-dot" style={{ background: color }} />
        <span className="mobile-card-repo" style={{ color }}>
          {issue.owner}/{issue.repo}
        </span>
        <span className="mobile-card-number">#{issue.number}</span>
        <span className="mobile-card-age">{relTime(issue.updatedAt)}</span>
      </div>
      <div className="mobile-card-body">
        <Link href={`/issues/${issue.id}`} className="mobile-card-body-link">
          <span className="mobile-card-title">{issue.title}</span>
          {issue.body && <div className="mobile-card-excerpt">{excerpt(issue.body)}</div>}
        </Link>
        {live && (
          <div className="mobile-card-status">
            <span className="mobile-card-status-dot" />
            {issue.state === 'developing'
              ? `developing${issue.modelId ? `… ${issue.modelId}` : '…'} (live via opencode)`
              : 'working… (live via opencode)'}
          </div>
        )}
        {issue.blockedReason && !justStarted && (
          <div className="card-blocked" role="alert">
            <strong>Needs input:</strong> {excerpt(issue.blockedReason)}
          </div>
        )}
      </div>
      <div className="mobile-card-footer">
        {primary.kind === 'work' ? (
          <button className="mobile-card-primary" onClick={onPrimaryAction} disabled={busy}>
            {primary.label}
          </button>
        ) : (
          <Link href={`/issues/${issue.id}`} className="mobile-card-primary mobile-card-primary-link">
            {primary.label}
          </Link>
        )}
        <button className="mobile-card-more" onClick={onOpenActions} aria-label="More actions">
          <span />
          <span />
          <span />
        </button>
      </div>
    </div>
  );
}
