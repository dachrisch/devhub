import { getDb } from '../store';
import type {
  ActivityEvent,
  ActivitySession,
  ActivityTokens,
  CostKind,
  IngestEvent,
  IngestSession,
} from './types';

// Persistence for the Agent Activity receiving side (devhub#271). Reads/writes
// the `activity_*` tables created in store.migrate(). Callers (the ingest route)
// own auth + validation; this module owns merge/idempotency semantics.

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Latest-updatedAt-wins upsert. An older batch never clobbers newer state
// (idempotent replay of a stale spool).
export function upsertActivitySessions(source: string, sessions: IngestSession[]): number {
  if (sessions.length === 0) return 0;
  const stmt = getDb().prepare(`
    INSERT INTO activity_session (
      source, session_id, harness, title, project, repo, branch, model, agent, status,
      activity, started_at, updated_at, tokens_json, cost, cost_kind, messages,
      tool_calls, last_seen
    ) VALUES (
      @source, @session_id, @harness, @title, @project, @repo, @branch, @model, @agent, @status,
      @activity, @started_at, @updated_at, @tokens_json, @cost, @cost_kind, @messages,
      @tool_calls, datetime('now')
    )
    ON CONFLICT(source, session_id) DO UPDATE SET
      harness = excluded.harness,
      title = excluded.title,
      project = excluded.project,
      repo = excluded.repo,
      branch = excluded.branch,
      model = excluded.model,
      agent = excluded.agent,
      status = excluded.status,
      activity = excluded.activity,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      tokens_json = excluded.tokens_json,
      cost = excluded.cost,
      cost_kind = excluded.cost_kind,
      messages = excluded.messages,
      tool_calls = excluded.tool_calls,
      last_seen = excluded.last_seen
    WHERE excluded.updated_at >= activity_session.updated_at
  `);
  const runAll = getDb().transaction((rows: IngestSession[]) => {
    let touched = 0;
    for (const s of rows) {
      const info = stmt.run({
        source,
        session_id: s.sessionId,
        harness: s.harness,
        title: s.title ?? null,
        project: s.project ?? null,
        repo: s.repo ?? null,
        branch: s.branch ?? null,
        model: s.model ?? null,
        agent: s.agent ?? null,
        status: s.status,
        activity: s.activity ?? null,
        started_at: s.startedAt ?? null,
        updated_at: s.updatedAt ?? 0,
        tokens_json: JSON.stringify(s.tokens ?? {}),
        cost: s.cost ?? null,
        cost_kind: s.costKind ?? 'reported',
        messages: s.messages ?? 0,
        tool_calls: s.toolCalls ?? 0,
      });
      touched += info.changes;
    }
    return touched;
  });
  return runAll(sessions);
}

// Append-only history with a (source, session_id, ts, type) dedupe key so
// retried batches don't duplicate rows. Returns the number of new rows.
export function appendActivityEvents(source: string, events: IngestEvent[]): number {
  if (events.length === 0) return 0;
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO activity_event (source, session_id, ts, type, tool, text)
    VALUES (@source, @session_id, @ts, @type, @tool, @text)
  `);
  const runAll = getDb().transaction((rows: IngestEvent[]) => {
    let inserted = 0;
    for (const e of rows) {
      const info = stmt.run({
        source,
        session_id: e.sessionId,
        ts: e.ts,
        type: e.type,
        tool: e.tool ?? null,
        text: e.text ?? null,
      });
      inserted += info.changes;
    }
    return inserted;
  });
  return runAll(events);
}

// Every ingest batch is a heartbeat. last_cursor + history are only overwritten
// when the producer actually sends them.
export function recordActivityHeartbeat(
  source: string,
  sentAt: number | null,
  lastCursor: string | null,
  history: unknown
): void {
  getDb()
    .prepare(`
      INSERT INTO activity_source (source, last_heartbeat, sent_at, last_cursor, history_json)
      VALUES (@source, datetime('now'), @sent_at, @last_cursor, @history_json)
      ON CONFLICT(source) DO UPDATE SET
        last_heartbeat = excluded.last_heartbeat,
        sent_at = excluded.sent_at,
        last_cursor = COALESCE(excluded.last_cursor, activity_source.last_cursor),
        history_json = COALESCE(excluded.history_json, activity_source.history_json)
    `)
    .run({
      source,
      sent_at: sentAt ?? null,
      last_cursor: lastCursor ?? null,
      history_json: history === undefined ? null : JSON.stringify(history),
    });
}

function rowToSession(row: Record<string, unknown>): ActivitySession {
  return {
    source: row.source as string,
    sessionId: row.session_id as string,
    harness: row.harness as ActivitySession['harness'],
    title: (row.title as string | null) ?? null,
    project: (row.project as string | null) ?? null,
    repo: (row.repo as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    agent: (row.agent as string | null) ?? null,
    status: row.status as ActivitySession['status'],
    activity: (row.activity as string | null) ?? null,
    startedAt: (row.started_at as number | null) ?? null,
    updatedAt: (row.updated_at as number | null) ?? null,
    tokens: parseJson<ActivityTokens>(row.tokens_json as string | null, {}),
    cost: (row.cost as number | null) ?? null,
    costKind: (row.cost_kind as CostKind) ?? 'reported',
    messages: (row.messages as number) ?? 0,
    toolCalls: (row.tool_calls as number) ?? 0,
    client: (row.client as string | null) ?? null,
    issueId: (row.issue_id as number | null) ?? null,
    attribution: parseJson<unknown>(row.attribution_json as string | null, null),
    lastSeen: row.last_seen as string,
  };
}

export function getActivityFleet(): ActivitySession[] {
  const rows = getDb()
    .prepare('SELECT * FROM activity_session ORDER BY updated_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function getActivityEvents(limit = 100): ActivityEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM activity_event ORDER BY ts DESC, id DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    source: row.source as string,
    sessionId: row.session_id as string,
    ts: row.ts as number,
    type: row.type as string,
    tool: (row.tool as string | null) ?? null,
    text: (row.text as string | null) ?? null,
  }));
}

export function getActivitySourceState(source: string) {
  const row = getDb()
    .prepare('SELECT * FROM activity_source WHERE source = ?')
    .get(source) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    source: row.source as string,
    lastHeartbeat: (row.last_heartbeat as string | null) ?? null,
    sentAt: (row.sent_at as number | null) ?? null,
    lastCursor: (row.last_cursor as string | null) ?? null,
    history: parseJson<unknown>(row.history_json as string | null, null),
  };
}
