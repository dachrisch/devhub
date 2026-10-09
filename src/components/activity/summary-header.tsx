'use client';

import type { ActivitySession } from '@/lib/activity/types';
import { summarizeFleet } from '@/lib/activity/view';

export function SummaryHeader({ fleet }: { fleet: ActivitySession[] }) {
  const s = summarizeFleet(fleet);
  return (
    <section className="activity-summary" aria-label="Fleet summary">
      <div className="activity-stat">
        <span className="activity-stat-num">{s.total}</span>
        <span className="activity-stat-label">sessions</span>
      </div>
      <div className="activity-stat activity-stat-working">
        <span className="activity-stat-num">{s.working}</span>
        <span className="activity-stat-label">working</span>
      </div>
      <div className="activity-stat activity-stat-needs">
        <span className="activity-stat-num">{s.needsInput}</span>
        <span className="activity-stat-label">needs input</span>
      </div>
      <div className="activity-stat">
        <span className="activity-stat-num">{s.opencode}</span>
        <span className="activity-stat-label">opencode</span>
      </div>
      <div className="activity-stat">
        <span className="activity-stat-num">{s.claude}</span>
        <span className="activity-stat-label">claude</span>
      </div>
    </section>
  );
}
