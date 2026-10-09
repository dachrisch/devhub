'use client';

import type { ActivitySession } from '@/lib/activity/types';
import { contextPct, elapsed, formatTokens, harnessLabel, statusLabel, totalTokens } from '@/lib/activity/view';

export function AgentTile({ session, now }: { session: ActivitySession; now: number }) {
  const pct = contextPct(session);
  const el = elapsed(session.startedAt ?? session.updatedAt, now);
  const where = session.repo ?? session.project ?? '(unknown project)';
  const harnessClass = harnessLabel(session).replace(/[^a-z]/g, '');
  return (
    <article className={`activity-tile activity-tile-${session.status}`} aria-label={`${where} — ${statusLabel(session.status)}`}>
      <header className="activity-tile-head">
        <span className={`activity-harness activity-harness-${harnessClass}`}>{harnessLabel(session)}</span>
        <span className={`activity-status activity-status-${session.status}`}>
          <span className="activity-status-dot" aria-hidden="true" />
          {statusLabel(session.status)}
        </span>
      </header>
      <div className="activity-tile-where">
        <span className="activity-repo" title={where}>
          {where}
        </span>
        {session.issueId != null && <span className="activity-issue-chip" title="DevHub issue">#{session.issueId}</span>}
      </div>
      <div className="activity-model">
        {session.model ?? 'unknown model'}
        {session.agent ? ` · ${session.agent}` : ''}
      </div>
      {session.activity && <p className="activity-line">{session.activity}</p>}
      <div className="activity-meta">
        {el && <span title="elapsed">◷ {el}</span>}
        <span title="total tokens">{formatTokens(totalTokens(session))} tok</span>
        {session.cost != null && (
          <span title={`cost (${session.costKind})`}>
            {session.costKind === 'estimated' ? '≈' : '$'}
            {session.cost.toFixed(3)}
          </span>
        )}
      </div>
      {pct != null && (
        <div className="activity-meter" role="img" aria-label={`context ${pct}%`}>
          <span className="activity-meter-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </article>
  );
}
