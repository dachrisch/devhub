'use client';

import { useState } from 'react';
import type { ActivitySession } from '@/lib/activity/types';
import {
  DEFAULT_TIMELINE_WINDOW,
  TIMELINE_WINDOWS,
  formatDuration,
  formatTokens,
  harnessLabel,
  laneWindow,
  sessionLabel,
  sortFleet,
  summarizeFleet,
  timelineTicks,
  timelineWindowMs,
  totalTokens,
  visibleFleet,
  type TimelineWindowKey,
} from '@/lib/activity/view';

// Live timeline (devhub#274): a Gantt-style view of the fleet. Lanes are
// headlined by session title; the bar spans the session runtime clipped to a
// fixed, selectable window. Placeholder/empty sessions are hidden; sessions
// that ended before the window stay listed with a ◀ out-of-window cap.

function costLabel(s: ActivitySession): string | null {
  if (s.cost == null) return null;
  return `${s.costKind === 'estimated' ? '≈' : '$'}${s.cost.toFixed(3)}`;
}

function Lane({ session, windowStart, windowEnd, now }: {
  session: ActivitySession;
  windowStart: number;
  windowEnd: number;
  now: number;
}) {
  const geo = laneWindow(session, windowStart, windowEnd, now);
  const label = sessionLabel(session);
  const harnessClass = harnessLabel(session).replace(/[^a-z]/g, '');
  const runtime = geo ? formatDuration(geo.runtimeMs) : null;
  const cost = costLabel(session);
  return (
    <li className={`activity-lane activity-lane-${session.status}`}>
      <div className="activity-lane-label">
        <span className={`activity-status activity-status-${session.status}`}>
          <span className="activity-status-dot" aria-hidden="true" />
        </span>
        <span className={`activity-harness activity-harness-${harnessClass}`}>{harnessLabel(session)}</span>
        <span className="activity-lane-title" title={label}>
          {geo?.outOfWindow && <span className="activity-lane-before" aria-hidden="true">◀ </span>}
          {label}
        </span>
        <span className="activity-lane-model">
          {session.model ?? 'unknown model'}
          {session.agent ? ` · ${session.agent}` : ''}
        </span>
      </div>
      <div className="activity-lane-track">
        {geo &&
          (geo.outOfWindow ? (
            <span
              className="activity-lane-bar activity-lane-bar-out"
              style={{ left: '0%', width: '4%' }}
              title="ended before window"
            />
          ) : (
            <span
              className={`activity-lane-bar${geo.clippedLeft ? ' activity-lane-bar-clipped' : ''}`}
              style={{ left: `${geo.x0 * 100}%`, width: `${Math.max(0.5, (geo.x1 - geo.x0) * 100)}%` }}
            />
          ))}
      </div>
      <div className="activity-lane-meta">
        {runtime && <span title="runtime">{runtime}</span>}
        <span title="total tokens">{formatTokens(totalTokens(session))} tok</span>
        {cost && <span title={`cost (${session.costKind})`}>{cost}</span>}
      </div>
    </li>
  );
}

export function Timeline({ fleet, now }: { fleet: ActivitySession[]; now: number }) {
  const [windowKey, setWindowKey] = useState<TimelineWindowKey>(DEFAULT_TIMELINE_WINDOW);
  const visible = visibleFleet(fleet);
  const sorted = sortFleet(visible);
  const summary = summarizeFleet(visible);
  const hidden = fleet.length - visible.length;
  const windowEnd = now;
  const windowStart = now - timelineWindowMs(windowKey);
  const ticks = timelineTicks(windowStart, windowEnd);

  return (
    <section className="activity-timeline" aria-label="Agent timeline">
      <header className="activity-timeline-head">
        <div className="activity-timeline-stats">
          <span className="activity-pill activity-pill-working">{summary.working} working</span>
          <span className="activity-pill activity-pill-needs">{summary.needsInput} needs input</span>
          <span className="activity-timeline-count">
            {visible.length} shown
            {hidden > 0 ? ` · ${hidden} hidden` : ''}
          </span>
        </div>
        <div className="activity-window" role="tablist" aria-label="Timeline window">
          {TIMELINE_WINDOWS.map((w) => (
            <button
              key={w.key}
              role="tab"
              aria-selected={windowKey === w.key}
              className={`activity-window-btn${windowKey === w.key ? ' is-active' : ''}`}
              onClick={() => setWindowKey(w.key)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      <div className="activity-axis" aria-hidden="true">
        <span className="activity-axis-before">◀ before</span>
        <div className="activity-axis-track">
          {ticks.map((t) => (
            <span key={t.at} className="activity-axis-tick" style={{ left: `${((t.at - windowStart) / (windowEnd - windowStart)) * 100}%` }}>
              {t.label}
            </span>
          ))}
          <span className="activity-axis-now">now ▸</span>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">no agent sessions right now</div>
      ) : (
        <ul className="activity-lanes">
          {sorted.map((s) => (
            <Lane
              key={`${s.source}:${s.sessionId}`}
              session={s}
              windowStart={windowStart}
              windowEnd={windowEnd}
              now={now}
            />
          ))}
        </ul>
      )}

      <footer className="activity-timeline-legend">
        <span><i className="dot dot-working" /> working</span>
        <span><i className="dot dot-idle" /> idle</span>
        <span><i className="dot dot-needs-input" /> needs input</span>
        <span><i className="dot dot-done" /> done</span>
        <span><i className="dot dot-error" /> error</span>
        <span className="activity-timeline-legend-note">bar = runtime (clipped to window) · ◀ = ended before window</span>
      </footer>
    </section>
  );
}
