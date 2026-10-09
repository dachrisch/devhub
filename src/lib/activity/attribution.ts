import { getDb } from '../store';
import type { ActivitySession } from './types';

// Attribution for agent sessions (devhub#273): map a session id back to the
// DevHub issue/repo/model/agent it drove. Built from the real `session_id`
// columns — no speculative event vocabulary. Unmatched sessions fall back to a
// per-source client label so unattributed traffic stays legible.

export interface SessionAttribution {
  client: string;
  issueId: number | null;
  owner: string | null;
  repo: string | null;
  number: number | null;
  projectId: number | null;
  model: string | null;
  agent: string | null;
  role: string | null;
}

function parseIds(raw: unknown): number[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function parseStrings(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

// Precedence (low → high): actions → issues → threads → develop_runs. A concrete
// develop run is the most specific attribution; it overwrites looser matches.
export function buildAttributionMap(): Map<string, SessionAttribution> {
  const db = getDb();
  const map = new Map<string, SessionAttribution>();

  const actions = db
    .prepare(`SELECT id, session_ids FROM actions WHERE session_ids IS NOT NULL AND session_ids != '[]'`)
    .all() as { id: number; session_ids: string }[];
  for (const a of actions) {
    for (const sid of parseStrings(a.session_ids)) {
      map.set(sid, {
        client: 'devhub',
        issueId: null,
        owner: null,
        repo: null,
        number: null,
        projectId: null,
        model: null,
        agent: null,
        role: null,
      });
    }
  }

  const issues = db
    .prepare(
      `SELECT id, owner, repo, number, session_id, model_id, project_id FROM issues WHERE session_id IS NOT NULL`
    )
    .all() as {
    id: number;
    owner: string;
    repo: string;
    number: number;
    session_id: string;
    model_id: string | null;
    project_id: number | null;
  }[];
  for (const i of issues) {
    map.set(i.session_id, {
      client: 'devhub',
      issueId: i.id,
      owner: i.owner,
      repo: `${i.owner}/${i.repo}`,
      number: i.number,
      projectId: i.project_id ?? null,
      model: i.model_id ?? null,
      agent: null,
      role: null,
    });
  }

  const threads = db
    .prepare(`SELECT id, session_id, issue_ids FROM threads WHERE session_id IS NOT NULL`)
    .all() as { id: number; session_id: string; issue_ids: string }[];
  for (const t of threads) {
    const issueIds = parseIds(t.issue_ids);
    map.set(t.session_id, {
      client: 'devhub',
      issueId: issueIds[0] ?? null,
      owner: null,
      repo: null,
      number: null,
      projectId: null,
      model: null,
      agent: null,
      role: 'planner',
    });
  }

  const runs = db
    .prepare(
      `SELECT d.session_id, d.issue_id, d.repo_owner, d.repo_name, d.role,
              i.number, i.project_id, i.model_id
         FROM develop_runs d
         LEFT JOIN issues i ON i.id = d.issue_id
        WHERE d.session_id IS NOT NULL`
    )
    .all() as {
    session_id: string;
    issue_id: number;
    repo_owner: string;
    repo_name: string;
    role: string;
    number: number | null;
    project_id: number | null;
    model_id: string | null;
  }[];
  for (const r of runs) {
    map.set(r.session_id, {
      client: 'devhub',
      issueId: r.issue_id,
      owner: r.repo_owner,
      repo: `${r.repo_owner}/${r.repo_name}`,
      number: r.number ?? null,
      projectId: r.project_id ?? null,
      model: r.model_id ?? null,
      agent: null,
      role: r.role,
    });
  }

  return map;
}

// Fallback client label for a session DevHub never dispatched.
export function fallbackClient(s: ActivitySession): string {
  if (s.source === 'opencode-web') return 'web/API (unattributed)';
  if (s.harness === 'claude') return 'claude-local';
  if (s.source === 'laptop' && s.harness === 'opencode') return 'opencode-local';
  return s.source;
}

export function attributeSession(
  session: ActivitySession,
  map: Map<string, SessionAttribution>
): ActivitySession {
  const a = map.get(session.sessionId);
  if (a) {
    return {
      ...session,
      client: a.client,
      issueId: a.issueId,
      repo: session.repo ?? a.repo,
      model: session.model ?? a.model,
      agent: session.agent ?? a.agent,
      attribution: a,
    };
  }
  return { ...session, client: fallbackClient(session) };
}

export function attributeFleet(
  fleet: ActivitySession[],
  map: Map<string, SessionAttribution> = buildAttributionMap()
): ActivitySession[] {
  return fleet.map((s) => attributeSession(s, map));
}
