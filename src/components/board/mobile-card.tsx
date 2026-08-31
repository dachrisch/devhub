'use client';

import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { excerpt, primaryCardAction, relTime } from '@/lib/board-ui';

interface MobileCardProps {
  issue: Issue;
  color: string;
  busy: boolean;
  onPrimaryAction: () => void;
  onOpenActions: () => void;
}

export function MobileCard({ issue, color, busy, onPrimaryAction, onOpenActions }: MobileCardProps) {
  const developing = issue.state === 'developing';
  const primary = primaryCardAction(issue);

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
        <a className="mobile-card-title" href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.title}
        </a>
        {issue.body && <div className="mobile-card-excerpt">{excerpt(issue.body)}</div>}
        {developing && (
          <div className="mobile-card-status">
            <span className="mobile-card-status-dot" />
            developing… (live via opencode)
          </div>
        )}
      </div>
      <div className="mobile-card-footer">
        {primary.kind === 'develop' ? (
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
