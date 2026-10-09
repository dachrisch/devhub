'use client';

import type { ActivitySession } from '@/lib/activity/types';
import { sortFleet } from '@/lib/activity/view';
import { AgentTile } from './agent-tile';

export function FleetGrid({ fleet, now }: { fleet: ActivitySession[]; now: number }) {
  const sorted = sortFleet(fleet);
  if (sorted.length === 0) return <div className="empty">no agent sessions right now</div>;
  return (
    <section className="activity-grid" aria-label="Agent fleet">
      {sorted.map((s) => (
        <AgentTile key={`${s.source}:${s.sessionId}`} session={s} now={now} />
      ))}
    </section>
  );
}
