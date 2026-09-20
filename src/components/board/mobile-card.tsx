'use client';

import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { excerpt, primaryCardAction, relTime } from '@/lib/board-ui';
import { RunChips, ScopeBadge, useRuns } from '@/components/board/run-chips';

interface MobileCardProps {
  issue: Issue;
  color: string;
  busy: boolean;
  // A run started from this client whose server-side state hasn't arrived via
  // SSE yet: the card must show live/recap affordances, never the Work button.
  justStarted?: boolean;
  onPrimaryAction: () => void;
  onOpenActions: () => void;
  // Shaping idea this work came from — same studio anchor as desktop.
  topicTitle?: string | null;
}

export function MobileCard({ issue, color, busy, justStarted = false, onPrimaryAction, onOpenActions, topicTitle = null }: MobileCardProps) {
  const live = justStarted || (issue.state === 'developing' && !issue.blockedReason);
  const primary = primaryCardAction(issue, live);
  const runs = useRuns(issue.id);

  return (
    <div className="mobile-card">
      <div className="mobile-card-strip" style={{ background: `${color}22` }}>
        <span className="mobile-card-dot" style={{ background: color }} />
        <span className="mobile-card-repo" style={{ color }}>
          {issue.owner}/{issue.repo}
        </span>
        <span className="mobile-card-number">#{issue.number}</span>
        <ScopeBadge issue={issue} />
        <span className="mobile-card-age">{relTime(issue.updatedAt)}</span>
      </div>
      <div className="mobile-card-body">
        <Link href={`/issues/${issue.id}`} className="mobile-card-body-link">
          <span className="mobile-card-title">{issue.title}</span>
          {issue.body && <div className="mobile-card-excerpt">{excerpt(issue.body)}</div>}
        </Link>
        {topicTitle && issue.topicId != null && (
          <div className="card-idea-link">
            <span className="card-idea-dot dot idea" aria-hidden="true" />
            <Link href={`/topics/${issue.topicId}`} className="card-idea-title">
              {topicTitle}
            </Link>
          </div>
        )}
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
        {issue.state === 'pr' && issue.resultPrUrl && (
          <div className="result pr-open" role="status">
            <strong>Pull request opened ✓</strong>{' '}
            <a href={issue.resultPrUrl} target="_blank" rel="noreferrer" title={issue.resultPrUrl}>
              Review it on GitHub ↗
            </a>
          </div>
        )}
        <RunChips issue={issue} runs={runs} />
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
