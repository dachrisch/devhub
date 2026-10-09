import { fetch as undiciFetch } from 'undici';
import { ENV } from '../../env';
import {
  authHeaders,
  insecureDispatcher,
  OpencodeUnavailableError,
  parseSseBlock,
  type OpencodeEvent,
} from '../../opencode';
import { appendActivityEvents } from '../store';
import type { ActivitySession, ActivityStatus, ActivityTokens, IngestEvent } from '../types';

// Activity source: the opencode web/API server (code.lehel.xyz). Probe-verified
// shape (devhub#272) — no volume mount, no OPENCODE_DATA_DIR:
//   GET /api/session        -> {"data": [<newest first, 50>], "cursor": {"next": <b64>}}
//   GET /api/session?cursor=<b64> -> next page
//   GET /event              -> global SSE, v2 {id,type,properties}; server.connected handshake
// Unknown routes fall through to the v2 SPA HTML (200) — treat that as not-found.

export const OPENCODE_WEB_SOURCE = 'opencode-web';

export interface OpencodeServerSession {
  id: string;
  parentID?: string | null;
  projectID?: string | null;
  agent?: string | null;
  model?: { id?: string; providerID?: string; variant?: string } | null;
  cost?: number | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number } | null;
  } | null;
  time?: { created?: number; updated?: number } | null;
  title?: string | null;
  location?: { directory?: string } | null;
}

interface OpencodePage {
  data?: unknown;
  cursor?: { next?: string | null } | null;
}

export interface OpencodeResponse {
  status: number;
  ok?: boolean;
  text: () => Promise<string>;
  body?: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  headers?: { get: (name: string) => string | null };
}

export type OpencodeFetch = (url: string, init?: Record<string, unknown>) => Promise<OpencodeResponse>;

const defaultFetch = undiciFetch as unknown as OpencodeFetch;

const RECENT_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAGES = 20;

// A session has no explicit status in the API snapshot; infer working vs idle
// from how recently it was touched.
export function deriveStatus(updated: number | null, now: number): ActivityStatus {
  if (updated == null) return 'idle';
  return now - updated < RECENT_WINDOW_MS ? 'working' : 'idle';
}

const HTML_RE = /^\s*(?:<!doctype\s+html|<html)/i;

export function isSpaHtml(body: string): boolean {
  return HTML_RE.test(body);
}

function modelLabel(model: OpencodeServerSession['model']): string | null {
  if (!model) return null;
  const parts = [model.providerID, model.id].filter((p): p is string => !!p);
  return parts.length ? parts.join('/') : null;
}

export function normalizeSession(s: OpencodeServerSession, now: number): ActivitySession {
  const updated = s.time?.updated ?? null;
  const tokens: ActivityTokens = {};
  const t = s.tokens;
  if (t) {
    if (t.input != null) tokens.input = t.input;
    if (t.output != null) tokens.output = t.output;
    if (t.reasoning != null) tokens.reasoning = t.reasoning;
    if (t.cache?.read != null) tokens.cacheRead = t.cache.read;
    if (t.cache?.write != null) tokens.cacheWrite = t.cache.write;
  }
  return {
    source: OPENCODE_WEB_SOURCE,
    sessionId: s.id,
    harness: 'opencode',
    title: s.title ?? null,
    project: s.location?.directory ?? null,
    repo: null,
    branch: null,
    model: modelLabel(s.model),
    agent: s.agent ?? null,
    status: deriveStatus(updated, now),
    activity: null,
    startedAt: s.time?.created ?? null,
    updatedAt: updated,
    tokens,
    cost: s.cost ?? null,
    costKind: 'reported',
    messages: 0,
    toolCalls: 0,
    client: null,
    issueId: null,
    attribution: s.parentID ? { parentId: s.parentID, projectId: s.projectID ?? null } : { projectId: s.projectID ?? null },
    lastSeen: new Date(now).toISOString(),
  };
}

async function safeFetch(
  fetchFn: OpencodeFetch,
  url: string,
  init: Record<string, unknown>
): Promise<OpencodeResponse> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpencodeUnavailableError(`opencode server unreachable: ${reason}`);
  }
}

const isOk = (res: OpencodeResponse): boolean =>
  res.ok ?? (res.status >= 200 && res.status < 300);

export interface ListSessionsOptions {
  fetchFn?: OpencodeFetch;
  signal?: AbortSignal;
  maxPages?: number;
  now?: number;
}

// Snapshot of every session on the server, walking the cursor. A SPA-HTML body
// (unknown route) is not-found and yields no sessions.
export async function listSessions(opts: ListSessionsOptions = {}): Promise<ActivitySession[]> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const now = opts.now ?? Date.now();
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const out: ActivitySession[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const url = cursor
      ? `${ENV.opencodeBaseUrl}/api/session?cursor=${encodeURIComponent(cursor)}`
      : `${ENV.opencodeBaseUrl}/api/session`;
    const res = await safeFetch(fetchFn, url, {
      headers: authHeaders(),
      dispatcher: insecureDispatcher,
      signal: opts.signal,
    });
    if (res.status >= 500) {
      throw new OpencodeUnavailableError(`opencode session list failed: ${res.status}`);
    }
    const body = await res.text();
    if (isSpaHtml(body)) return out;
    if (!isOk(res)) return out;
    let parsed: OpencodePage;
    try {
      parsed = JSON.parse(body) as OpencodePage;
    } catch {
      return out;
    }
    const rows = Array.isArray(parsed.data) ? (parsed.data as OpencodeServerSession[]) : [];
    for (const row of rows) {
      if (row && typeof row.id === 'string') out.push(normalizeSession(row, now));
    }
    cursor = parsed.cursor?.next ?? null;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

// Subscribes to the global opencode /event SSE. The `server.connected`
// handshake is liveness-only and is not forwarded.
export async function subscribeEvents(
  onEvent: (event: { type?: string; kind?: string; [k: string]: unknown }) => void,
  signal?: AbortSignal,
  fetchFn: OpencodeFetch = defaultFetch
): Promise<void> {
  let res: OpencodeResponse;
  try {
    res = await safeFetch(fetchFn, `${ENV.opencodeBaseUrl}/event`, {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      dispatcher: insecureDispatcher,
      signal,
    });
  } catch {
    return;
  }
  if (!isOk(res)) return;
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = parseSseBlock(raw);
        if (event && event.type !== 'server.connected') onEvent(event);
      }
    }
  } catch {
    // best-effort live feed
  }
}

let cache: { at: number; sessions: ActivitySession[] } | null = null;
const DEFAULT_TTL_MS = 15_000;

// Short-TTL cache so GET /api/activity can include the server fleet without
// hammering opencode on every request. A failed refresh falls back to the last
// good snapshot.
export async function getOpencodeFleetCached(ttlMs = DEFAULT_TTL_MS): Promise<ActivitySession[]> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.sessions;
  try {
    const sessions = await listSessions();
    cache = { at: Date.now(), sessions };
    return sessions;
  } catch (err) {
    if (cache) return cache.sessions;
    throw err;
  }
}

export function resetOpencodeFleetCacheForTests(): void {
  cache = null;
}

// --- Event collection (devhub#274) -------------------------------------------
// The Live timeline headlines lanes with titles and does NOT render event
// ticks, but the opencode /event stream is still collected into activity_event
// for later use. Persist-only, best-effort, and guarded on globalThis so HMR /
// repeated imports never stack subscriptions.

function numOr(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return null;
}

function eventSessionId(props: Record<string, unknown>): string | null {
  const part = props.part as Record<string, unknown> | undefined;
  const info = props.info as Record<string, unknown> | undefined;
  const message = props.message as Record<string, unknown> | undefined;
  return firstString(props.sessionID, part?.sessionID, info?.sessionID, info?.id, message?.sessionID);
}

function eventText(part: Record<string, unknown> | undefined): string | null {
  if (!part) return null;
  const state = part.state as Record<string, unknown> | undefined;
  const input = state?.input as Record<string, unknown> | undefined;
  return firstString(state?.title, input?.command, input?.description, part.text);
}

// Maps one opencode /event into the append-only ingest shape. Events without a
// session id are dropped (nothing to attribute them to).
export function toIngestEvent(event: OpencodeEvent, now = Date.now()): IngestEvent | null {
  const type = firstString(event.type, event.kind);
  if (!type) return null;
  const props = (event.properties ?? {}) as Record<string, unknown>;
  const sessionId = eventSessionId(props);
  if (!sessionId) return null;
  const part = props.part as Record<string, unknown> | undefined;
  const time = (part?.time ?? props.time) as Record<string, unknown> | undefined;
  const ts = numOr(time?.start) ?? numOr(time?.created) ?? now;
  const tool = part && typeof part.tool === 'string' ? part.tool : null;
  return { sessionId, ts, type, tool, text: eventText(part) };
}

interface EventSubscriptionState {
  started: boolean;
}

const EVENT_SUB_KEY = '__devhubOpencodeActivityEventSub';
const EVENT_RETRY_MS = 5000;

async function runEventSubscription(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await subscribeEvents((event) => {
        const mapped = toIngestEvent(event);
        if (!mapped) return;
        try {
          appendActivityEvents(OPENCODE_WEB_SOURCE, [mapped]);
        } catch {
          // best-effort persistence; a failing DB must not kill the loop
        }
      }, signal);
    } catch {
      // subscribeEvents already swallows fetch errors; guard the mapper too
    }
    if (signal.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, EVENT_RETRY_MS));
  }
}

// Idempotent across HMR: the subscription lives for the process lifetime.
export function ensureOpencodeEventSubscription(): void {
  const g = globalThis as unknown as Record<string, EventSubscriptionState | undefined>;
  if (g[EVENT_SUB_KEY]?.started) return;
  g[EVENT_SUB_KEY] = { started: true };
  void runEventSubscription(new AbortController().signal);
}
