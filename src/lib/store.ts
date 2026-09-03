import Database from 'better-sqlite3';
import { ENV } from './env';
import { serializeIssue, type Issue, type IssueEvent, type IssueRow, type IssueState } from './types';

export type { Issue, IssueEvent, IssueState } from './types';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(ENV.dbPath);
    db.pragma('journal_mode = WAL');
    migrate(db);
  }
  return db;
}

// Test-only: drop the cached connection so a later getDb() re-opens the file
// and re-runs migrate() against whatever rows are on disk.
export function closeDbForTests(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_issue_id INTEGER NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      html_url TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'backlog',
      session_id TEXT,
      result_pr_url TEXT,
      result_text TEXT,
      linked_pr_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner, repo, number)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      login TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'unknown',
      params TEXT NOT NULL DEFAULT '{}',
      skill_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      session_ids TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      repo_owner TEXT,
      repo_name TEXT,
      deploy_host TEXT,
      deploy_dir TEXT,
      domain TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_deploy_at TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // One-time migration: rollout metadata for the terminal "released" state.
  const issueCols = database.prepare('PRAGMA table_info(issues)').all() as { name: string }[];
  const hasColumn = (name: string) => issueCols.some((c) => c.name === name);
  if (!hasColumn('release_tag')) {
    database.exec(`ALTER TABLE issues ADD COLUMN release_tag TEXT`);
  }
  if (!hasColumn('released_at')) {
    database.exec(`ALTER TABLE issues ADD COLUMN released_at TEXT`);
  }
  if (!hasColumn('state_reason')) {
    database.exec(`ALTER TABLE issues ADD COLUMN state_reason TEXT`);
  }
  if (!hasColumn('model_id')) {
    database.exec(`ALTER TABLE issues ADD COLUMN model_id TEXT`);
  }

  // One-time migration: the `blocked` state was removed (devhub#132). Failures
  // now stay in their stage with a `blocked_reason`. Legacy blocked rows move
  // to `backlog` with their failure text preserved as the reason. Idempotent:
  // nothing ever writes `blocked` again, so the SELECT finds nothing after the
  // first pass.
  if (!hasColumn('blocked_reason')) {
    database.exec(`ALTER TABLE issues ADD COLUMN blocked_reason TEXT`);
  }
  const blockedIssues = database
    .prepare("SELECT id, result_text FROM issues WHERE state = 'blocked'")
    .all() as { id: number; result_text: string | null }[];
  for (const issue of blockedIssues) {
    database
      .prepare(
        `UPDATE issues SET state = 'backlog', blocked_reason = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(`Previous attempt: ${issue.result_text ?? 'needs review'}`, issue.id);
  }

  // One-time migration: refresh token support for OAuth sessions.
  const sessionCols = database.prepare('PRAGMA table_info(auth_sessions)').all() as { name: string }[];
  const hasSessionCol = (name: string) => sessionCols.some((c) => c.name === name);
  if (!hasSessionCol('refresh_token')) {
    database.exec(`ALTER TABLE auth_sessions ADD COLUMN refresh_token TEXT`);
  }
  if (!hasSessionCol('token_expires_at')) {
    database.exec(`ALTER TABLE auth_sessions ADD COLUMN token_expires_at TEXT`);
  }
}

export interface UpsertIssueInput {
  githubIssueId: number;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
}

// Insert as backlog, or refresh metadata only when the row is still in backlog
// (or was reconciled to `closed` — a reopened issue must pick up fresh
// metadata so the reconcile pass can move it back to the active board).
// Rows already developing / pr / rollout are never clobbered.
export function upsertIssue(input: UpsertIssueInput): void {
  getDb()
    .prepare(
      `INSERT INTO issues (github_issue_id, owner, repo, number, title, body, html_url, state)
       VALUES (@githubIssueId, @owner, @repo, @number, @title, @body, @htmlUrl, 'backlog')
       ON CONFLICT(owner, repo, number) DO UPDATE SET
         github_issue_id = excluded.github_issue_id,
         title = excluded.title,
         body = excluded.body,
         html_url = excluded.html_url,
         updated_at = datetime('now')
       WHERE state = 'backlog' OR state = 'closed'`
    )
    .run(input);
}

export function getIssues(): Issue[] {
  const rows = getDb().prepare('SELECT * FROM issues ORDER BY updated_at DESC, id DESC').all() as IssueRow[];
  return rows.map(serializeIssue);
}

export function getIssue(id: number): Issue | null {
  const row = getDb().prepare('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow | undefined;
  return row ? serializeIssue(row) : null;
}

export function getIssueByGithub(owner: string, repo: string, number: number): Issue | null {
  const row = getDb()
    .prepare('SELECT * FROM issues WHERE owner = ? AND repo = ? AND number = ?')
    .get(owner, repo, number) as IssueRow | undefined;
  return row ? serializeIssue(row) : null;
}

export function deleteIssueByGithub(owner: string, repo: string, number: number): void {
  getDb().prepare('DELETE FROM issues WHERE owner = ? AND repo = ? AND number = ?').run(owner, repo, number);
}

export function setIssueState(id: number, state: IssueState): Issue | null {
  getDb()
    .prepare(`UPDATE issues SET state = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(state, id);
  return getIssue(id);
}

export function recoverStuckDeveloping(): number {
  const db = getDb();
  const stuck = db.prepare('SELECT id FROM issues WHERE state = ?').all('developing') as { id: number }[];
  if (stuck.length === 0) return 0;

  // Stay in `developing` with a reason (devhub#132): the card remains in its
  // stage and a "Work" click resumes from there.
  db.prepare(
    `UPDATE issues SET session_id = NULL, blocked_reason = 'Server restart interrupted the develop run — click Work to retry.', updated_at = datetime('now')
     WHERE state = 'developing'`
  ).run();

  for (const { id } of stuck) {
    appendEvent(id, 'recovery', { reason: 'server restart interrupted develop run' });
  }

  return stuck.length;
}

// Surfaces a stage-level failure: the issue keeps its state, the reason is
// shown on the card and cleared by the next "Work" click.
export function setBlockedReason(id: number, reason: string): Issue | null {
  getDb()
    .prepare(`UPDATE issues SET blocked_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(reason, id);
  return getIssue(id);
}

export function clearBlockedReason(id: number): Issue | null {
  getDb()
    .prepare(`UPDATE issues SET blocked_reason = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(id);
  return getIssue(id);
}

// Persists a refined issue body produced during the refinement stage.
export function setIssueBody(id: number, body: string): Issue | null {
  getDb()
    .prepare(`UPDATE issues SET body = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(body, id);
  return getIssue(id);
}

export function setSessionId(id: number, sessionId: string): void {
  getDb().prepare(`UPDATE issues SET session_id = ?, updated_at = datetime('now') WHERE id = ?`).run(sessionId, id);
}

export function setResult(id: number, state: IssueState, resultPrUrl: string | null, resultText: string | null): Issue | null {
  getDb()
    .prepare(
      `UPDATE issues SET state = ?, result_pr_url = ?, result_text = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(state, resultPrUrl, resultText, id);
  return getIssue(id);
}

export function setLinkedPrUrl(id: number, linkedPrUrl: string | null): void {
  getDb().prepare(`UPDATE issues SET linked_pr_url = ?, updated_at = datetime('now') WHERE id = ?`).run(linkedPrUrl, id);
}

// Marks a merged + release-tagged PR as rolled out (the board's "done" state).
export function setRollout(id: number, releaseTag: string): Issue | null {
  getDb()
    .prepare(
      `UPDATE issues SET state = 'rollout', release_tag = ?, released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
    .run(releaseTag, id);
  return getIssue(id);
}

// Terminal state for issues closed on GitHub outside DevHub's own pipeline
// (manually, duplicate/wontfix, fixed by hand). `reason` is GitHub's
// `state_reason` (e.g. "completed", "not_planned", "reopened").
export function setClosed(id: number, reason: string | null): Issue | null {
  getDb()
    .prepare(
      `UPDATE issues SET state = 'closed', state_reason = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(reason, id);
  return getIssue(id);
}

// Re-admits a card that GitHub reopened (the issue is open again): back to
// backlog, clearing the closure metadata.
export function reopenIssue(id: number): Issue | null {
  getDb()
    .prepare(
      `UPDATE issues SET state = 'backlog', state_reason = NULL, session_id = NULL, blocked_reason = NULL, updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
  return getIssue(id);
}

export function appendEvent(issueId: number, kind: string, payload: unknown): IssueEvent {
  const info = getDb()
    .prepare(`INSERT INTO events (issue_id, kind, payload_json) VALUES (?, ?, ?)`)
    .run(issueId, kind, JSON.stringify(payload ?? null));
  // Cache the model id on the issue row so the board card can render it
  // without querying the events table.
  if (kind === 'model' && payload && typeof payload === 'object') {
    const p = payload as { id?: unknown };
    if (typeof p.id === 'string') {
      getDb().prepare(`UPDATE issues SET model_id = ? WHERE id = ?`).run(p.id, issueId);
    }
  }
  const row = getDb().prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid) as {
    id: number;
    issue_id: number;
    kind: string;
    payload_json: string;
    ts: string;
  };
  return {
    id: row.id,
    issueId: row.issue_id,
    kind: row.kind,
    payload: safeParse(row.payload_json),
    ts: row.ts,
  };
}

export function getEvents(issueId: number): IssueEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY id ASC')
    .all(issueId) as { id: number; issue_id: number; kind: string; payload_json: string; ts: string }[];
  return rows.map((r) => ({
    id: r.id,
    issueId: r.issue_id,
    kind: r.kind,
    payload: safeParse(r.payload_json),
    ts: r.ts,
  }));
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export interface AuthSessionRow {
  id: string;
  token: string;
  login: string;
  avatar_url: string | null;
  created_at: string;
  expires_at: string;
  refresh_token: string | null;
  token_expires_at: string | null;
}

export interface AuthSession {
  id: string;
  token: string;
  login: string;
  avatarUrl: string | null;
  createdAt: string;
  expiresAt: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

export function createAuthSession(session: AuthSession): void {
  const db = getDb();
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= datetime('now')`).run();
  db.prepare(
    `INSERT INTO auth_sessions (id, token, login, avatar_url, created_at, expires_at, refresh_token, token_expires_at)
     VALUES (@id, @token, @login, @avatarUrl, @createdAt, @expiresAt, @refreshToken, @tokenExpiresAt)`
  ).run(session);
}

export function getAuthSession(id: string): AuthSession | null {
  const row = getDb().prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as AuthSessionRow | undefined;
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    deleteAuthSession(id);
    return null;
  }
  return serializeAuthSession(row);
}

export function deleteAuthSession(id: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
}

export function updateSessionToken(
  id: string,
  token: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE auth_sessions SET token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?`
    )
    .run(token, refreshToken, tokenExpiresAt, id);
}

function serializeAuthSession(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    token: row.token,
    login: row.login,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
  };
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export interface ActionRow {
  id: number;
  input: string;
  action: string;
  params: string;
  skillId: string | null;
  status: string;
  result: string | null;
  sessionIds: string;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPreference {
  id: string;
  providerID: string;
}

const DEFAULT_MODEL_KEY = 'default_model';

// The operator's remembered global default model (null = no override).
export function getDefaultModel(): ModelPreference | null {
  const raw = getSetting(DEFAULT_MODEL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ModelPreference;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.providerID === 'string') return parsed;
  } catch {
    /* ignore malformed */
  }
  return null;
}

export function setDefaultModel(model: ModelPreference | null): void {
  setSetting(DEFAULT_MODEL_KEY, model ? JSON.stringify(model) : '');
}

export function appendAction(input: string, action: string, params: Record<string, unknown>): ActionRow {
  const info = getDb()
    .prepare(`INSERT INTO actions (input, action, params) VALUES (?, ?, ?)`)
    .run(input, action, JSON.stringify(params));
  return getAction(Number(info.lastInsertRowid))!;
}

export function getAction(id: number): ActionRow | null {
  const row = getDb().prepare('SELECT * FROM actions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    input: row.input as string,
    action: row.action as string,
    params: row.params as string,
    skillId: row.skill_id as string | null,
    status: row.status as string,
    result: row.result as string | null,
    sessionIds: row.session_ids as string,
    durationMs: row.duration_ms as number | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function setActionStatus(id: number, status: string, result?: string, durationMs?: number): void {
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const args: (string | number)[] = [status];
  if (result !== undefined) { sets.push('result = ?'); args.push(result); }
  if (durationMs !== undefined) { sets.push('duration_ms = ?'); args.push(durationMs); }
  args.push(id);
  getDb().prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function appendSessionId(actionId: number, sessionId: string): void {
  const row = getDb().prepare('SELECT session_ids FROM actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!row) return;
  const ids = JSON.parse(row.session_ids as string) as string[];
  ids.push(sessionId);
  getDb().prepare(`UPDATE actions SET session_ids = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(ids), actionId);
}

export function getActions(limit = 20): ActionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    input: r.input as string,
    action: r.action as string,
    params: r.params as string,
    skillId: r.skill_id as string | null,
    status: r.status as string,
    result: r.result as string | null,
    sessionIds: r.session_ids as string,
    durationMs: r.duration_ms as number | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export interface ServiceRow {
  id: number; name: string; repoOwner: string | null; repoName: string | null;
  deployHost: string | null; deployDir: string | null; domain: string | null;
  status: string; lastDeployAt: string | null; config: string; createdAt: string;
}

export function getServices(): ServiceRow[] {
  const rows = getDb().prepare('SELECT * FROM services ORDER BY name').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number, name: r.name as string,
    repoOwner: r.repo_owner as string | null, repoName: r.repo_name as string | null,
    deployHost: r.deploy_host as string | null, deployDir: r.deploy_dir as string | null,
    domain: r.domain as string | null, status: r.status as string,
    lastDeployAt: r.last_deploy_at as string | null,
    config: r.config as string, createdAt: r.created_at as string,
  }));
}

export function getServiceByName(name: string): ServiceRow | null {
  const row = getDb().prepare('SELECT * FROM services WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number, name: row.name as string,
    repoOwner: row.repo_owner as string | null, repoName: row.repo_name as string | null,
    deployHost: row.deploy_host as string | null, deployDir: row.deploy_dir as string | null,
    domain: row.domain as string | null, status: row.status as string,
    lastDeployAt: row.last_deploy_at as string | null,
    config: row.config as string, createdAt: row.created_at as string,
  };
}

export function upsertService(input: { name: string; repoOwner?: string; repoName?: string;
  deployHost?: string; deployDir?: string; domain?: string; config?: Record<string, unknown> }): ServiceRow {
  getDb().prepare(`INSERT INTO services (name, repo_owner, repo_name, deploy_host, deploy_dir, domain, config)
    VALUES (@name, @repoOwner, @repoName, @deployHost, @deployDir, @domain, @config)
    ON CONFLICT(name) DO UPDATE SET
      repo_owner = excluded.repo_owner, repo_name = excluded.repo_name,
      deploy_host = excluded.deploy_host, deploy_dir = excluded.deploy_dir,
      domain = excluded.domain, config = excluded.config
  `).run({
    name: input.name,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    deployHost: input.deployHost ?? null,
    deployDir: input.deployDir ?? null,
    domain: input.domain ?? null,
    config: JSON.stringify(input.config ?? {}),
  });
  return getServiceByName(input.name)!;
}
