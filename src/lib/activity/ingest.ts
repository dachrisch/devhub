import crypto from 'node:crypto';
import type {
  ActivityHarness,
  ActivityStatus,
  ActivityTokens,
  CostKind,
  IngestBatch,
  IngestEvent,
  IngestSession,
} from './types';

// Constant-time compare for the ingest shared secret. Guards the length first:
// timingSafeEqual throws on unequal lengths.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const HARNESSES: readonly ActivityHarness[] = ['claude', 'opencode'];
const STATUSES: readonly ActivityStatus[] = ['working', 'needs-input', 'idle', 'done', 'error'];
const COST_KINDS: readonly CostKind[] = ['reported', 'estimated'];

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseTokens(v: unknown): ActivityTokens {
  if (!v || typeof v !== 'object') return {};
  const t = v as Record<string, unknown>;
  const out: ActivityTokens = {};
  for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'contextUsed', 'contextLimit'] as const) {
    const n = num(t[key]);
    if (n !== null) out[key] = n;
  }
  return out;
}

function parseSession(raw: unknown): IngestSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const sessionId = str(s.sessionId);
  if (!sessionId) return null;
  const harness = str(s.harness) as ActivityHarness | null;
  const status = str(s.status) as ActivityStatus | null;
  const costKind = str(s.costKind) as CostKind | null;
  return {
    harness: harness && HARNESSES.includes(harness) ? harness : 'opencode',
    sessionId,
    title: str(s.title),
    project: str(s.project),
    repo: str(s.repo),
    branch: str(s.branch),
    model: str(s.model),
    agent: str(s.agent),
    status: status && STATUSES.includes(status) ? status : 'idle',
    activity: str(s.activity),
    startedAt: num(s.startedAt),
    updatedAt: num(s.updatedAt),
    tokens: parseTokens(s.tokens),
    cost: num(s.cost),
    costKind: costKind && COST_KINDS.includes(costKind) ? costKind : 'reported',
    messages: num(s.messages) ?? 0,
    toolCalls: num(s.toolCalls) ?? 0,
  };
}

function parseEvent(raw: unknown): IngestEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const sessionId = str(e.sessionId);
  const ts = num(e.ts);
  const type = str(e.type);
  if (!sessionId || ts === null || !type) return null;
  return { sessionId, ts, type, tool: str(e.tool), text: str(e.text) };
}

// Validates an untrusted request body into a batch. Returns null only when the
// envelope itself is unusable (missing/blank source); individual malformed
// sessions/events are dropped rather than failing the whole batch.
export function parseBatch(body: unknown): IngestBatch | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const source = str(b.source);
  if (!source || !source.trim()) return null;
  const sessions = Array.isArray(b.sessions)
    ? b.sessions.map(parseSession).filter((s): s is IngestSession => s !== null)
    : [];
  const events = Array.isArray(b.events)
    ? b.events.map(parseEvent).filter((e): e is IngestEvent => e !== null)
    : [];
  return {
    source,
    sentAt: num(b.sentAt) ?? undefined,
    sessions,
    events,
    history: b.history,
  };
}
