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

// Insert as backlog, or refresh metadata only when the row is still in backlog.
// Rows already developing / pr / blocked are never clobbered.
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
       WHERE state = 'backlog'`
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
  const result = getDb()
    .prepare(
      `UPDATE issues SET state = 'blocked', result_text = 'recovered from stuck developing state (server restart interrupted the develop run).', updated_at = datetime('now')
       WHERE state = 'developing'`
    )
    .run();
  return result.changes;
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

export function appendEvent(issueId: number, kind: string, payload: unknown): IssueEvent {
  const info = getDb()
    .prepare(`INSERT INTO events (issue_id, kind, payload_json) VALUES (?, ?, ?)`)
    .run(issueId, kind, JSON.stringify(payload ?? null));
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
}

export interface AuthSession {
  id: string;
  token: string;
  login: string;
  avatarUrl: string | null;
  createdAt: string;
  expiresAt: string;
}

export function createAuthSession(session: AuthSession): void {
  const db = getDb();
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= datetime('now')`).run();
  db.prepare(
    `INSERT INTO auth_sessions (id, token, login, avatar_url, created_at, expires_at)
     VALUES (@id, @token, @login, @avatarUrl, @createdAt, @expiresAt)`
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

function serializeAuthSession(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    token: row.token,
    login: row.login,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
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
