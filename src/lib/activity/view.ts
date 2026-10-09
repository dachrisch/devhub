import type { ActivitySession, ActivityStatus, UsageBucket } from './types';

// Pure shaping used by the /activity page (devhub#274). Kept out of the
// components so it can be unit-tested in the node-only vitest setup.

const STATUS_ORDER: Record<ActivityStatus, number> = {
  'needs-input': 0,
  error: 1,
  working: 2,
  idle: 3,
  done: 4,
};

// Needs-input pinned first, then errors/working; newest within a status.
export function sortFleet(fleet: ActivitySession[]): ActivitySession[] {
  return [...fleet].sort((a, b) => {
    const rank = (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5);
    if (rank !== 0) return rank;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

export interface FleetSummary {
  total: number;
  needsInput: number;
  working: number;
  idle: number;
  done: number;
  error: number;
  opencode: number;
  claude: number;
  clients: { key: string; count: number }[];
}

export function summarizeFleet(fleet: ActivitySession[]): FleetSummary {
  const summary: FleetSummary = {
    total: fleet.length,
    needsInput: 0,
    working: 0,
    idle: 0,
    done: 0,
    error: 0,
    opencode: 0,
    claude: 0,
    clients: [],
  };
  const clients = new Map<string, number>();
  for (const s of fleet) {
    if (s.status === 'needs-input') summary.needsInput += 1;
    else if (s.status === 'working') summary.working += 1;
    else if (s.status === 'idle') summary.idle += 1;
    else if (s.status === 'done') summary.done += 1;
    else if (s.status === 'error') summary.error += 1;
    if (s.harness === 'claude') summary.claude += 1;
    else summary.opencode += 1;
    const key = s.client ?? '(unknown)';
    clients.set(key, (clients.get(key) ?? 0) + 1);
  }
  summary.clients = [...clients.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  return summary;
}

export function totalTokens(s: ActivitySession): number {
  const t = s.tokens;
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
}

export function contextPct(s: ActivitySession): number | null {
  const used = s.tokens.contextUsed;
  const limit = s.tokens.contextLimit;
  if (!used || !limit || limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}

export function elapsed(from: number | null, now: number): string | null {
  if (from == null) return null;
  return formatDuration(now - from);
}

export function harnessLabel(s: ActivitySession): string {
  if (s.source === 'opencode-web') return 'opencode-web';
  if (s.harness === 'claude') return 'claude-local';
  if (s.harness === 'opencode' && s.source === 'laptop') return 'opencode-local';
  return s.harness;
}

// opencode's own default titles ("New session - <ISO>", "Child session - <ISO>").
// Mirrors the server regex so placeholder sessions are filtered identically.
const PLACEHOLDER_TITLE_RE = /^(?:New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && PLACEHOLDER_TITLE_RE.test(title.trim());
}

// A session with no work to show: no tokens, no messages, no activity line.
export function isEmptySession(s: ActivitySession): boolean {
  return totalTokens(s) === 0 && s.messages === 0 && !s.activity;
}

// The Live timeline hides placeholder (never-titled) and empty sessions.
export function visibleFleet(fleet: ActivitySession[]): ActivitySession[] {
  return fleet.filter((s) => !isPlaceholderTitle(s.title) && !isEmptySession(s));
}

// Lane headline: the session title, falling back to repo/project/harness.
export function sessionLabel(s: ActivitySession): string {
  const title = s.title?.trim();
  if (title && !isPlaceholderTitle(title)) return title;
  return s.repo ?? s.project ?? harnessLabel(s);
}

export const TIMELINE_WINDOWS = [
  { key: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { key: '6h', label: '6h', ms: 6 * 60 * 60 * 1000 },
  { key: '12h', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

export type TimelineWindowKey = (typeof TIMELINE_WINDOWS)[number]['key'];

export const DEFAULT_TIMELINE_WINDOW: TimelineWindowKey = '6h';

export function timelineWindowMs(key: TimelineWindowKey): number {
  return TIMELINE_WINDOWS.find((w) => w.key === key)?.ms ?? 6 * 60 * 60 * 1000;
}

export interface LaneGeometry {
  // Fractions of the window width (0 = windowStart, 1 = windowEnd).
  x0: number;
  x1: number;
  // Full runtime in ms (start→end), independent of window clipping.
  runtimeMs: number;
  clippedLeft: boolean;
  // Ended before the window start: pinned to the left edge with a ◀ cap.
  outOfWindow: boolean;
}

// Geometry for one lane. Never returns null when the session has any timing;
// the window only scales/clips the bar, it never drops the session (devhub#274).
export function laneWindow(
  s: ActivitySession,
  windowStart: number,
  windowEnd: number,
  now: number
): LaneGeometry | null {
  if (s.startedAt == null && s.updatedAt == null) return null;
  const end = s.status === 'working' ? now : s.updatedAt ?? now;
  const start = s.startedAt ?? end;
  const runtimeMs = Math.max(0, end - start);
  const span = Math.max(1, windowEnd - windowStart);
  if (end < windowStart) {
    return { x0: 0, x1: 0, runtimeMs, clippedLeft: true, outOfWindow: true };
  }
  const visStart = Math.max(start, windowStart);
  const visEnd = Math.max(Math.min(end, windowEnd), visStart);
  return {
    x0: Math.min(1, Math.max(0, (visStart - windowStart) / span)),
    x1: Math.min(1, Math.max(0, (visEnd - windowStart) / span)),
    runtimeMs,
    clippedLeft: start < windowStart,
    outOfWindow: false,
  };
}

const TICK_STEPS_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Axis labels at "nice" clock steps, targeting ~`target` ticks across the window.
export function timelineTicks(
  windowStart: number,
  windowEnd: number,
  target = 4
): { at: number; label: string }[] {
  const span = Math.max(1, windowEnd - windowStart);
  const ideal = span / Math.max(1, target);
  const step = TICK_STEPS_MS.find((s) => s >= ideal) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const out: { at: number; label: string }[] = [];
  for (let t = Math.ceil(windowStart / step) * step; t < windowEnd && out.length < 12; t += step) {
    out.push({ at: t, label: formatClock(t) });
  }
  return out;
}

export function statusLabel(status: ActivityStatus): string {
  return status === 'needs-input' ? 'needs input' : status;
}

export function sumCost(buckets: UsageBucket[]): { reported: number; estimated: number } {
  return buckets.reduce(
    (acc, b) => ({ reported: acc.reported + b.costReported, estimated: acc.estimated + b.costEstimated }),
    { reported: 0, estimated: 0 }
  );
}

export function dailyMax(days: UsageBucket[]): number {
  return days.reduce((max, d) => Math.max(max, d.sessions), 0);
}
