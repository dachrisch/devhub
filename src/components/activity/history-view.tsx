'use client';

import type { UsageBucket, UsageHistory } from '@/lib/activity/types';
import { dailyMax, formatTokens, sumCost } from '@/lib/activity/view';

function DailyBars({ days }: { days: UsageBucket[] }) {
  const max = dailyMax(days) || 1;
  const w = Math.max(days.length * 24, 240);
  const h = 90;
  const base = h - 18;
  return (
    <svg className="activity-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Daily sessions, ${days.length} days`}>
      {days.map((d, i) => {
        const bh = Math.max(2, Math.round((d.sessions / max) * (base - 8)));
        return (
          <rect
            key={d.key}
            x={i * 24 + 3}
            y={base - bh}
            width={18}
            height={bh}
            rx={3}
            className="activity-bar"
          >
            <title>{`${d.key}: ${d.sessions} sessions, ${formatTokens(d.tokens)} tokens`}</title>
          </rect>
        );
      })}
      {days.map((d, i) => (
        <text key={`${d.key}-l`} x={i * 24 + 12} y={h - 4} textAnchor="middle" className="activity-bar-label">
          {d.key.slice(5)}
        </text>
      ))}
    </svg>
  );
}

function RankList({ buckets, ariaLabel }: { buckets: UsageBucket[]; ariaLabel: string }) {
  if (buckets.length === 0) return <p className="activity-empty">no data</p>;
  const max = buckets.reduce((m, b) => Math.max(m, b.sessions), 0) || 1;
  return (
    <ul className="activity-rank" aria-label={ariaLabel}>
      {buckets.slice(0, 8).map((b) => (
        <li key={b.key} className="activity-rank-row">
          <span className="activity-rank-key" title={b.key}>
            {b.key}
          </span>
          <span className="activity-rank-bar" aria-hidden="true">
            <span className="activity-rank-fill" style={{ width: `${Math.round((b.sessions / max) * 100)}%` }} />
          </span>
          <span className="activity-rank-num">
            {b.sessions} · {formatTokens(b.tokens)} tok
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HistoryView({ history }: { history: UsageHistory }) {
  const empty = history.days.length === 0 && history.models.length === 0 && history.projects.length === 0;
  if (empty) return <div className="empty">no history yet</div>;
  const cost = sumCost(history.days);
  return (
    <div className="activity-history">
      <section className="activity-panel">
        <h2>daily sessions</h2>
        <DailyBars days={history.days} />
      </section>
      <section className="activity-panel">
        <h2>model mix</h2>
        <RankList buckets={history.models} ariaLabel="Model mix" />
      </section>
      <section className="activity-panel">
        <h2>projects</h2>
        <RankList buckets={history.projects} ariaLabel="Project ranking" />
      </section>
      <section className="activity-panel">
        <h2>clients</h2>
        <RankList buckets={history.clients} ariaLabel="Per-client split" />
      </section>
      <section className="activity-panel activity-cost">
        <h2>cost</h2>
        <p>
          reported <strong>${cost.reported.toFixed(2)}</strong>
        </p>
        <p>
          estimated <strong>≈${cost.estimated.toFixed(2)}</strong>
        </p>
        <small>provenance kept separate — never summed across modes</small>
      </section>
    </div>
  );
}
