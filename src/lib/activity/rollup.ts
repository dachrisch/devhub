import { getDb } from '../store';
import { getActivityFleet } from './store';
import { attributeFleet } from './attribution';
import { getOpencodeFleetCached } from './sources/opencode-api';
import type { ActivitySession, UsageBucket, UsageHistory } from './types';

// Durable usage history (devhub#273). usage_session accumulates every session
// DevHub has ever seen (server + ingested), so re-deriving usage_daily from it
// survives opencode's 7-day prune. Cost provenance is kept in separate columns
// and never summed across kinds.

const STALE_MS = 15 * 60 * 1000;
const ROLLUP_KEY = 'rollup';

interface UsageRow {
  source: string;
  sessionId: string;
  harness: string;
  client: string | null;
  project: string | null;
  repo: string | null;
  model: string | null;
  agent: string | null;
  issueId: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  tokensJson: string;
  costReported: number | null;
  costEstimated: number | null;
}

function toUsageRow(s: ActivitySession): UsageRow {
  const cost = s.cost ?? null;
  return {
    source: s.source,
    sessionId: s.sessionId,
    harness: s.harness,
    client: s.client,
    project: s.project,
    repo: s.repo,
    model: s.model,
    agent: s.agent,
    issueId: s.issueId,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    tokensJson: JSON.stringify(s.tokens ?? {}),
    // estimated cost is never recorded as reported, and vice versa
    costReported: s.costKind === 'estimated' ? null : cost,
    costEstimated: s.costKind === 'estimated' ? cost : null,
  };
}

export function upsertUsageSessions(sessions: ActivitySession[]): void {
  if (sessions.length === 0) return;
  const stmt = getDb().prepare(`
    INSERT INTO usage_session (
      source, session_id, harness, client, project, repo, model, agent, issue_id,
      started_at, updated_at, tokens_json, cost_reported, cost_estimated
    ) VALUES (
      @source, @sessionId, @harness, @client, @project, @repo, @model, @agent, @issueId,
      @startedAt, @updatedAt, @tokensJson, @costReported, @costEstimated
    )
    ON CONFLICT(source, session_id) DO UPDATE SET
      harness = excluded.harness,
      client = excluded.client,
      project = excluded.project,
      repo = excluded.repo,
      model = excluded.model,
      agent = excluded.agent,
      issue_id = excluded.issue_id,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      tokens_json = excluded.tokens_json,
      cost_reported = excluded.cost_reported,
      cost_estimated = excluded.cost_estimated
    WHERE excluded.updated_at >= usage_session.updated_at
  `);
  const run = getDb().transaction((rows: ActivitySession[]) => {
    for (const s of rows) {
      const r = toUsageRow(s);
      stmt.run({ ...r, updatedAt: r.updatedAt ?? 0 });
    }
  });
  run(sessions);
}

// Re-derive every daily bucket from the durable usage_session set.
export function recomputeUsageDaily(): void {
  const db = getDb();
  db.exec('DELETE FROM usage_daily');
  db.exec(`
    INSERT INTO usage_daily (
      day, source, client, project, model, sessions,
      tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      cost_reported, cost_estimated
    )
    SELECT
      strftime('%Y-%m-%d', COALESCE(updated_at, started_at) / 1000, 'unixepoch') AS day,
      source,
      COALESCE(client, '(unknown)'),
      COALESCE(project, '(unknown)'),
      COALESCE(model, '(unknown)'),
      COUNT(*),
      COALESCE(SUM(json_extract(tokens_json, '$.input')), 0),
      COALESCE(SUM(json_extract(tokens_json, '$.output')), 0),
      COALESCE(SUM(json_extract(tokens_json, '$.reasoning')), 0),
      COALESCE(SUM(json_extract(tokens_json, '$.cacheRead')), 0),
      COALESCE(SUM(json_extract(tokens_json, '$.cacheWrite')), 0),
      COALESCE(SUM(cost_reported), 0),
      COALESCE(SUM(cost_estimated), 0)
    FROM usage_session
    WHERE COALESCE(updated_at, started_at) IS NOT NULL
    GROUP BY day, source, client, project, model
  `);
}

// Refresh-if-stale (>15 min) on read; also fired opportunistically on ingest.
// `opencode:false` skips the server fetch (offline / tests).
export async function refreshUsageRollupsIfStale(
  opts: { force?: boolean; now?: number; opencode?: boolean } = {}
): Promise<boolean> {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const state = db.prepare('SELECT last_rollup_at FROM usage_source_state WHERE source = ?').get(ROLLUP_KEY) as
    | { last_rollup_at: number | null }
    | undefined;
  if (!opts.force && state?.last_rollup_at && now - state.last_rollup_at < STALE_MS) return false;

  let web: ActivitySession[] = [];
  if (opts.opencode !== false) {
    try {
      web = await getOpencodeFleetCached();
    } catch {
      web = [];
    }
  }
  const fleet = attributeFleet([...web, ...getActivityFleet()]);
  upsertUsageSessions(fleet);
  recomputeUsageDaily();
  db.prepare(`
    INSERT INTO usage_source_state (source, last_rollup_at) VALUES (?, ?)
    ON CONFLICT(source) DO UPDATE SET last_rollup_at = excluded.last_rollup_at
  `).run(ROLLUP_KEY, now);
  return true;
}

const TOKEN_SUM = 'tokens_in + tokens_out + tokens_reasoning + tokens_cache_read + tokens_cache_write';

function buckets(sql: string): UsageBucket[] {
  const rows = getDb().prepare(sql).all() as {
    key: string;
    sessions: number;
    tokens: number;
    costReported: number;
    costEstimated: number;
  }[];
  return rows.map((r) => ({
    key: r.key,
    sessions: r.sessions,
    tokens: r.tokens,
    costReported: r.costReported,
    costEstimated: r.costEstimated,
  }));
}

export function getUsageHistory(): UsageHistory {
  return {
    days: buckets(`
      SELECT day AS key, SUM(sessions) AS sessions, SUM(${TOKEN_SUM}) AS tokens,
             SUM(cost_reported) AS costReported, SUM(cost_estimated) AS costEstimated
      FROM usage_daily GROUP BY day ORDER BY day ASC
    `),
    clients: buckets(`
      SELECT client AS key, SUM(sessions) AS sessions, SUM(${TOKEN_SUM}) AS tokens,
             SUM(cost_reported) AS costReported, SUM(cost_estimated) AS costEstimated
      FROM usage_daily GROUP BY client ORDER BY sessions DESC
    `),
    projects: buckets(`
      SELECT project AS key, SUM(sessions) AS sessions, SUM(${TOKEN_SUM}) AS tokens,
             SUM(cost_reported) AS costReported, SUM(cost_estimated) AS costEstimated
      FROM usage_daily GROUP BY project ORDER BY sessions DESC
    `),
    models: buckets(`
      SELECT model AS key, SUM(sessions) AS sessions, SUM(${TOKEN_SUM}) AS tokens,
             SUM(cost_reported) AS costReported, SUM(cost_estimated) AS costEstimated
      FROM usage_daily GROUP BY model ORDER BY sessions DESC
    `),
  };
}
