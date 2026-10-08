'use client';

// Collapsible activity timeline from event rows (issue events or thread
// events) — one tinted dot per kind, relative timestamps, capped previews.
// Default-open when the item is blocked so the last failure is visible.

export interface ActivityRow {
  id: string;
  kind: string;
  ts: string;
  text: string;
}

const DOT_CLASS: Record<string, string> = {
  agent: 'dot-agent',
  user: 'dot-user',
  system: 'dot-system',
  state: 'dot-state',
  run: 'dot-run',
  recovery: 'dot-recovery',
  verification: 'dot-verification',
};

function relTime(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function preview(text: string, max = 200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function ActivityTimeline({ rows, defaultOpen = false }: { rows: ActivityRow[]; defaultOpen?: boolean }) {
  if (rows.length === 0) return null;
  const shown = [...rows].reverse().slice(0, 20);
  return (
    <details className="v2-activity" open={defaultOpen}>
      <summary>Activity ({rows.length})</summary>
      <ul>
        {shown.map((r) => (
          <li key={r.id} className="v2-activity-row">
            <span className={`v2-activity-dot ${DOT_CLASS[r.kind] ?? 'dot-system'}`} aria-hidden="true" />
            <span className="v2-activity-time">{relTime(r.ts)}</span>
            <span className="v2-activity-text">{preview(r.text)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
