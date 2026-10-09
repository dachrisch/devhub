'use client';

import type { ActivitySession } from '@/lib/activity/types';
import { elapsed, harnessLabel, sortFleet } from '@/lib/activity/view';

// Condensed live rail: newest/most-urgent sessions first.
export function ActivityTicker({ fleet, now }: { fleet: ActivitySession[]; now: number }) {
  const rows = sortFleet(fleet).slice(0, 12);
  return (
    <aside className="activity-ticker" aria-label="Live activity">
      <h2 className="activity-ticker-title">live</h2>
      {rows.length === 0 && <p className="activity-ticker-empty">quiet</p>}
      <ul className="activity-ticker-list">
        {rows.map((s) => (
          <li key={`${s.source}:${s.sessionId}`} className="activity-ticker-row">
            <span className={`activity-ticker-dot dot-${s.status}`} aria-hidden="true" />
            <span className="activity-ticker-text">{s.repo ?? s.project ?? harnessLabel(s)}</span>
            <span className="activity-ticker-time">{elapsed(s.updatedAt, now) ?? ''}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
