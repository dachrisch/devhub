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

export function elapsed(from: number | null, now: number): string | null {
  if (from == null) return null;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}

export function harnessLabel(s: ActivitySession): string {
  if (s.source === 'opencode-web') return 'opencode-web';
  if (s.harness === 'claude') return 'claude-local';
  if (s.harness === 'opencode' && s.source === 'laptop') return 'opencode-local';
  return s.harness;
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
