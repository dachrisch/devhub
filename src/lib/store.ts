import Database from 'better-sqlite3';
import { ENV } from './env';
import {
  serializeIdeaMessage,
  serializeIssue,
  serializeProject,
  serializeRun,
  serializeTopic,
  type DevelopRun,
  type DevelopRunRow,
  type IdeaMessage,
  type IdeaMessageRole,
  type IdeaMessageRow,
  type IdeaOption,
  type Issue,
  type IssueEvent,
  type IssueRow,
  type IssueState,
  type Project,
  type ProjectRow,
  type ProjectStatus,
  type ReleaseMode,
  type RepoScope,
  type RunRole,
  type RunState,
  type Topic,
  type TopicRow,
  type TopicStatus,
} from './types';

export type {
  DevelopRun,
  IdeaMessage,
  IdeaMessageRole,
  IdeaOption,
  Issue,
  IssueEvent,
  IssueState,
  Project,
  ProjectStatus,
  RepoScope,
  RunRole,
  RunState,
  Topic,
  TopicStatus,
  ReleaseMode,
} from './types';

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
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      service_repo_owner TEXT,
      service_repo_name TEXT,
      domain TEXT,
      deploy_host TEXT,
      deploy_dir TEXT,
      infra_dir TEXT,
      status TEXT,
      status_override TEXT,
      last_shipped_at TEXT,
      last_shipped_title TEXT,
      release_mode TEXT NOT NULL DEFAULT 'tag',
      auto_merge INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      area TEXT,
      title TEXT NOT NULL,
      notes TEXT,
      shaped_summary TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      merged_into_topic_id INTEGER NULL REFERENCES topics(id) ON DELETE SET NULL,
      ready_at TEXT NULL,
      origin TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_topics_project ON topics(project_id);
    CREATE TABLE IF NOT EXISTS develop_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT,
      pr_url TEXT,
      result_text TEXT,
      blocked_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_develop_runs_issue ON develop_runs(issue_id);
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

  // One-time migration: rolling opencode output per cockpit action, persisted
  // while the run is live so a client opening the detail view mid-run (or
  // reloading the page) sees the transcript so far.
  const actionCols = database.prepare('PRAGMA table_info(actions)').all() as { name: string }[];
  if (!actionCols.some((c) => c.name === 'transcript')) {
    database.exec(`ALTER TABLE actions ADD COLUMN transcript TEXT`);
  }

  // Projects & Topics reorganization (devhub#167): issues carry project/topic
  // assignment plus the refinement-decided repo scope. Columns stay nullable
  // in the schema (SQLite cannot ADD COLUMN NOT NULL without a default for
  // this backfill); every issue gets an assignment below and every ingest
  // path assigns on creation, so nulls never occur after migration.
  if (!hasColumn('project_id')) {
    database.exec(`ALTER TABLE issues ADD COLUMN project_id INTEGER REFERENCES projects(id)`);
  }
  if (!hasColumn('topic_id')) {
    database.exec(`ALTER TABLE issues ADD COLUMN topic_id INTEGER REFERENCES topics(id)`);
  }
  if (!hasColumn('repo_scope')) {
    database.exec(`ALTER TABLE issues ADD COLUMN repo_scope TEXT`);
  }
  if (!hasColumn('infra_first')) {
    database.exec(`ALTER TABLE issues ADD COLUMN infra_first INTEGER NOT NULL DEFAULT 0`);
  }

  // Ideas-first Realize flow (devhub#171 Phase 1): topic shaping columns +
  // per-project auto-merge opt-out. Idempotent ADD COLUMN guards.
  const projectCols = database.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
  const hasProjectCol = (name: string) => projectCols.some((c) => c.name === name);
  if (!hasProjectCol('auto_merge')) {
    database.exec(`ALTER TABLE projects ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 1`);
  }
  const topicCols = database.prepare('PRAGMA table_info(topics)').all() as { name: string }[];
  const hasTopicCol = (name: string) => topicCols.some((c) => c.name === name);
  if (!hasTopicCol('shaped_summary')) {
    database.exec(`ALTER TABLE topics ADD COLUMN shaped_summary TEXT`);
  }
  if (!hasTopicCol('merged_into_topic_id')) {
    database.exec(`ALTER TABLE topics ADD COLUMN merged_into_topic_id INTEGER NULL REFERENCES topics(id) ON DELETE SET NULL`);
  }
  if (!hasTopicCol('ready_at')) {
    database.exec(`ALTER TABLE topics ADD COLUMN ready_at TEXT NULL`);
  }
  // Vocabulary migration: idea→new, active→realizing. `shaping` is reserved
  // for topics with an open thread, so legacy one-shot ideas land on `new`.
  database.exec(`UPDATE topics SET status = 'new' WHERE status = 'idea'`);
  database.exec(`UPDATE topics SET status = 'realizing' WHERE status = 'active'`);

  // Ideas-first shaping loop (devhub#171 Phase 2): the options thread.
  database.exec(`
    CREATE TABLE IF NOT EXISTS idea_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      options_json TEXT NULL,
      chosen_option TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_idea_messages_topic ON idea_messages(topic_id)`);

  // Seed projects from the legacy services table (services stays in place,
  // unused, until a later cleanup). Idempotent: matched by name.
  const services = database.prepare('SELECT * FROM services').all() as Record<string, unknown>[];
  for (const s of services) {
    const name = s.name as string;
    const existing = database.prepare('SELECT id FROM projects WHERE name = ?').get(name);
    if (existing) continue;
    database
      .prepare(
        `INSERT INTO projects (name, service_repo_owner, service_repo_name, domain, deploy_host, deploy_dir, config)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        s.repo_owner ?? null,
        s.repo_name ?? null,
        s.domain ?? null,
        s.deploy_host ?? null,
        s.deploy_dir ?? null,
        typeof s.config === 'string' ? s.config : '{}'
      );
  }

  // Assign every issue to a project: repo → matching project, else a skeleton
  // project auto-created on first sight. Unsorted only as a last resort.
  const unassigned = database
    .prepare('SELECT id, owner, repo FROM issues WHERE project_id IS NULL')
    .all() as { id: number; owner: string; repo: string }[];
  for (const row of unassigned) {
    const project = ensureProjectForRepo(row.owner, row.repo);
    if (project) {
      database.prepare(`UPDATE issues SET project_id = ? WHERE id = ?`).run(project.id, row.id);
    } else {
      const unsorted = ensureUnsortedProject();
      database.prepare(`UPDATE issues SET project_id = ? WHERE id = ?`).run(unsorted.id, row.id);
    }
  }
}

// Looks up the project owning a repo, creating a skeleton project when a repo
// is seen for the first time (migration + ingest). Returns null only when both
// owner and repo are unusable.
export function ensureProjectForRepo(owner: string | null, repo: string | null): Project | null {
  if (!repo) return null;
  const db = getDb();
  if (owner) {
    const byRepo = db
      .prepare('SELECT * FROM projects WHERE service_repo_owner = ? AND service_repo_name = ?')
      .get(owner, repo) as ProjectRow | undefined;
    if (byRepo) return serializeProject(byRepo);
  }
  const name = uniqueProjectName(repo);
  const info = db
    .prepare(
      `INSERT INTO projects (name, service_repo_owner, service_repo_name) VALUES (?, ?, ?)`
    )
    .run(name, owner, repo);
  return getProject(Number(info.lastInsertRowid));
}

// Synthetic last-resort project for issues whose repo can't be resolved.
function ensureUnsortedProject(): Project {
  const existing = getProjectByName('Unsorted');
  if (existing) return existing;
  const info = getDb().prepare(`INSERT INTO projects (name) VALUES ('Unsorted')`).run();
  return getProject(Number(info.lastInsertRowid))!;
}

function uniqueProjectName(base: string): string {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM projects WHERE name = ?').get(base)) return base;
  let i = 2;
  while (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
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
export function upsertIssue(input: UpsertIssueInput): Issue {
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
  return getIssueByGithub(input.owner, input.repo, input.number)!;
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
  transcript: string | null;
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
    transcript: (row.transcript as string | null) ?? null,
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
  // The transcript is excluded from list payloads (potentially tens of KB per
  // row); the detail endpoint serves it via getAction.
  const rows = getDb()
    .prepare(
      `SELECT id, input, action, params, skill_id, status, result, session_ids,
              NULL AS transcript, duration_ms, created_at, updated_at
       FROM actions ORDER BY created_at DESC LIMIT ?`
    )
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
    transcript: (r.transcript as string | null) ?? null,
    durationMs: r.duration_ms as number | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

// Persists the rolling opencode output captured during a cockpit run. Called
// on a throttle (~1/s) while the action runs and once at its terminal state.
export function setActionTranscript(id: number, transcript: string): void {
  getDb()
    .prepare(`UPDATE actions SET transcript = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(transcript, id);
}

// Persists the classified intent so future runs can learn from it
// (correction pairs, unknown clustering). Best-effort: never throws.
export function setActionIntent(
  id: number,
  action: string,
  skillId: string | null,
  params: Record<string, unknown>
): void {
  try {
    getDb()
      .prepare(
        `UPDATE actions SET action = ?, skill_id = ?, params = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(action, skillId, JSON.stringify(params), id);
  } catch (err) {
    console.error('[store] setActionIntent failed:', err);
  }
}

export interface ServiceRow {
  id: number; name: string; repoOwner: string | null; repoName: string | null;
  deployHost: string | null; deployDir: string | null; domain: string | null;
  status: string; lastDeployAt: string | null; config: string; createdAt: string;
}

// Legacy (pre-#167): the services table is superseded by projects. Kept for
// the one-time migration seed only — launch.ts and /api/services now read the
// projects table. Remove with the table in a later cleanup.

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

// ---------------------------------------------------------------------------
// Projects & Topics (devhub#167)
// ---------------------------------------------------------------------------

export function getProjects(): Project[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
  return rows.map(serializeProject);
}

export function getProject(id: number): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? serializeProject(row) : null;
}

export function getProjectByName(name: string): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
  return row ? serializeProject(row) : null;
}

export function getProjectByRepo(owner: string, repo: string): Project | null {
  const row = getDb()
    .prepare('SELECT * FROM projects WHERE service_repo_owner = ? AND service_repo_name = ?')
    .get(owner, repo) as ProjectRow | undefined;
  return row ? serializeProject(row) : null;
}

export function createProject(input: {
  name: string;
  serviceRepoOwner?: string | null;
  serviceRepoName?: string | null;
  domain?: string | null;
  deployHost?: string | null;
  deployDir?: string | null;
  infraDir?: string | null;
  releaseMode?: ReleaseMode;
  autoMerge?: boolean;
  config?: Record<string, unknown>;
}): Project {
  const info = getDb()
    .prepare(
      `INSERT INTO projects (name, service_repo_owner, service_repo_name, domain, deploy_host, deploy_dir, infra_dir, release_mode, auto_merge, config)
       VALUES (@name, @serviceRepoOwner, @serviceRepoName, @domain, @deployHost, @deployDir, @infraDir, @releaseMode, @autoMerge, @config)`
    )
    .run({
      name: input.name,
      serviceRepoOwner: input.serviceRepoOwner ?? null,
      serviceRepoName: input.serviceRepoName ?? null,
      domain: input.domain ?? null,
      deployHost: input.deployHost ?? null,
      deployDir: input.deployDir ?? null,
      infraDir: input.infraDir ?? null,
      releaseMode: input.releaseMode ?? 'tag',
      autoMerge: input.autoMerge === false ? 0 : 1,
      config: JSON.stringify(input.config ?? {}),
    });
  return getProject(Number(info.lastInsertRowid))!;
}

export interface ProjectPatch {
  name?: string;
  serviceRepoOwner?: string | null;
  serviceRepoName?: string | null;
  domain?: string | null;
  deployHost?: string | null;
  deployDir?: string | null;
  infraDir?: string | null;
  statusOverride?: ProjectStatus | null;
  releaseMode?: ReleaseMode;
  autoMerge?: boolean;
  config?: Record<string, unknown>;
}

export function updateProject(id: number, patch: ProjectPatch): Project | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const bind = (column: string, value: string | number | null): void => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (patch.name !== undefined) bind('name', patch.name);
  if (patch.serviceRepoOwner !== undefined) bind('service_repo_owner', patch.serviceRepoOwner);
  if (patch.serviceRepoName !== undefined) bind('service_repo_name', patch.serviceRepoName);
  if (patch.domain !== undefined) bind('domain', patch.domain);
  if (patch.deployHost !== undefined) bind('deploy_host', patch.deployHost);
  if (patch.deployDir !== undefined) bind('deploy_dir', patch.deployDir);
  if (patch.infraDir !== undefined) bind('infra_dir', patch.infraDir);
  if (patch.statusOverride !== undefined) bind('status_override', patch.statusOverride);
  if (patch.releaseMode !== undefined) bind('release_mode', patch.releaseMode);
  if (patch.autoMerge !== undefined) bind('auto_merge', patch.autoMerge ? 1 : 0);
  if (patch.config !== undefined) bind('config', JSON.stringify(patch.config));
  if (sets.length === 0) return getProject(id);
  args.push(id);
  getDb().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getProject(id);
}

// Projects with assigned issues cannot be deleted — reassign first.
export function deleteProject(id: number): { ok: boolean; error?: string } {
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM issues WHERE project_id = ?').get(id) as { n: number };
  if (count.n > 0) return { ok: false, error: `project still has ${count.n} issue(s); reassign them first` };
  getDb().prepare('DELETE FROM topics WHERE project_id = ?').run(id);
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return { ok: true };
}

// Recomputes the cached derived status; the override (if any) always wins.
export function setProjectStatus(id: number, status: ProjectStatus | null): void {
  getDb().prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(status, id);
}

export function setProjectShipped(id: number, shippedAt: string, title: string): void {
  getDb()
    .prepare(
      `UPDATE projects SET last_shipped_at = ?, last_shipped_title = ? WHERE id = ?`
    )
    .run(shippedAt, title, id);
}

export function getIssuesByProject(projectId: number): Issue[] {
  const rows = getDb()
    .prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY updated_at DESC, id DESC')
    .all(projectId) as IssueRow[];
  return rows.map(serializeIssue);
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface TopicFilter {
  projectId?: number | null;
  status?: TopicStatus;
  area?: string;
}

export function getTopics(filter: TopicFilter = {}): Topic[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filter.projectId === null) {
    clauses.push('project_id IS NULL');
  } else if (filter.projectId !== undefined) {
    clauses.push('project_id = ?');
    args.push(filter.projectId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    args.push(filter.status);
  }
  if (filter.area) {
    clauses.push('area = ?');
    args.push(filter.area);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM topics ${where} ORDER BY updated_at DESC, id DESC`)
    .all(...args) as TopicRow[];
  return rows.map(serializeTopic);
}

export function getTopic(id: number): Topic | null {
  const row = getDb().prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
  return row ? serializeTopic(row) : null;
}

export function createTopic(input: {
  title: string;
  notes?: string | null;
  shapedSummary?: string | null;
  projectId?: number | null;
  area?: string | null;
  status?: TopicStatus;
  origin?: 'manual' | 'suggested';
}): Topic {
  const info = getDb()
    .prepare(
      `INSERT INTO topics (title, notes, shaped_summary, project_id, area, status, origin) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.notes ?? null,
      input.shapedSummary ?? null,
      input.projectId ?? null,
      input.area ?? null,
      input.status ?? 'new',
      input.origin ?? 'manual'
    );
  return getTopic(Number(info.lastInsertRowid))!;
}

export interface TopicPatch {
  title?: string;
  notes?: string | null;
  shapedSummary?: string | null;
  projectId?: number | null;
  area?: string | null;
  status?: TopicStatus;
  mergedIntoTopicId?: number | null;
  readyAt?: string | null;
}

export function updateTopic(id: number, patch: TopicPatch): Topic | null {
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); args.push(patch.title); }
  if (patch.notes !== undefined) { sets.push('notes = ?'); args.push(patch.notes); }
  if (patch.shapedSummary !== undefined) { sets.push('shaped_summary = ?'); args.push(patch.shapedSummary); }
  if (patch.projectId !== undefined) { sets.push('project_id = ?'); args.push(patch.projectId); }
  if (patch.area !== undefined) { sets.push('area = ?'); args.push(patch.area); }
  if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
  if (patch.mergedIntoTopicId !== undefined) { sets.push('merged_into_topic_id = ?'); args.push(patch.mergedIntoTopicId); }
  if (patch.readyAt !== undefined) { sets.push('ready_at = ?'); args.push(patch.readyAt); }
  args.push(id);
  getDb().prepare(`UPDATE topics SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getTopic(id);
}

// Link-and-archive for duplicates (devhub#171): the loser becomes `dropped`
// with a pointer to the winner. It disappears from active lists but stays
// searchable via GET /api/topics (no status filter).
export function mergeTopic(id: number, intoId: number): Topic | null {
  const loser = getTopic(id);
  const winner = getTopic(intoId);
  if (!loser || !winner || id === intoId) return null;
  return updateTopic(id, { status: 'dropped', mergedIntoTopicId: intoId });
}

export function getIssuesByTopic(topicId: number): Issue[] {
  const rows = getDb()
    .prepare('SELECT * FROM issues WHERE topic_id = ? ORDER BY updated_at DESC, id DESC')
    .all(topicId) as IssueRow[];
  return rows.map(serializeIssue);
}

export function getActiveTopicsForProject(projectId: number, limit = 3): Topic[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM topics WHERE project_id = ? AND status IN ('new','shaping','ready','realizing') ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
    .all(projectId, limit) as TopicRow[];
  return rows.map(serializeTopic);
}

// ---------------------------------------------------------------------------
// Idea messages — the options thread (devhub#171 Phase 2)
// ---------------------------------------------------------------------------

// Atomic new→shaping transition for the shaping loop: returns true only when
// this caller won the transition (a concurrent promote may have moved the
// topic to realizing first — then shaping stays out of the way).
export function markTopicShaping(id: number): boolean {
  const info = getDb()
    .prepare(`UPDATE topics SET status = 'shaping', updated_at = datetime('now') WHERE id = ? AND status = 'new'`)
    .run(id);
  return info.changes > 0;
}

export function getIdeaMessages(topicId: number): IdeaMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM idea_messages WHERE topic_id = ? ORDER BY id ASC')
    .all(topicId) as IdeaMessageRow[];
  return rows.map(serializeIdeaMessage);
}

export function getIdeaMessage(id: number): IdeaMessage | null {
  const row = getDb().prepare('SELECT * FROM idea_messages WHERE id = ?').get(id) as IdeaMessageRow | undefined;
  return row ? serializeIdeaMessage(row) : null;
}

export function appendIdeaMessage(
  topicId: number,
  role: IdeaMessageRole,
  body: string,
  options?: IdeaOption[] | null
): IdeaMessage {
  const info = getDb()
    .prepare(`INSERT INTO idea_messages (topic_id, role, body, options_json) VALUES (?, ?, ?, ?)`)
    .run(topicId, role, body, options && options.length > 0 ? JSON.stringify(options) : null);
  getDb().prepare(`UPDATE topics SET updated_at = datetime('now') WHERE id = ?`).run(topicId);
  return getIdeaMessage(Number(info.lastInsertRowid))!;
}

// Records the user's pick on an assistant message. Returns null when the
// message has no such option (stale/mismatched optionId).
export function chooseIdeaOption(messageId: number, optionId: string): IdeaMessage | null {
  const message = getIdeaMessage(messageId);
  if (!message?.options?.some((o) => o.id === optionId)) return null;
  getDb().prepare(`UPDATE idea_messages SET chosen_option = ? WHERE id = ?`).run(optionId, messageId);
  return getIdeaMessage(messageId);
}

export function deleteTopic(id: number): void {
  // Unlink issues first; the topic itself is history.
  getDb().prepare('UPDATE issues SET topic_id = NULL WHERE topic_id = ?').run(id);
  // The options thread goes with the topic (FK cascade is not enforced).
  getDb().prepare('DELETE FROM idea_messages WHERE topic_id = ?').run(id);
  // Duplicates merged into this topic lose their winner pointer (FK is not
  // enforced by default in SQLite, so clear explicitly).
  getDb().prepare('UPDATE topics SET merged_into_topic_id = NULL WHERE merged_into_topic_id = ?').run(id);
  getDb().prepare('DELETE FROM topics WHERE id = ?').run(id);
}

// Recomputes a topic's status from its linked issues (unified funnel):
// all settled (rollout|closed) → `shipped`; started work
// (refinement|developing|pr|rollout) → `realizing`; fresh promotion
// (backlog only) → `ready`; no issues → leave untouched (devhub#171 §5.1).
// A reopened terminal topic (`dropped`/`shipped` with live work) still reads
// as `realizing`, as before.
export function refreshTopicStatus(topicId: number): Topic | null {
  const topic = getTopic(topicId);
  if (!topic) return null;
  const issues = getDb()
    .prepare('SELECT state FROM issues WHERE topic_id = ?')
    .all(topicId) as { state: IssueState }[];
  if (issues.length === 0) return topic;
  const settled = issues.every((i) => i.state === 'rollout' || i.state === 'closed');
  const started = issues.some(
    (i) => i.state === 'refinement' || i.state === 'developing' || i.state === 'pr' || i.state === 'rollout'
  );
  let next: TopicStatus;
  if (settled) next = 'shipped';
  else if (started) next = 'realizing';
  else if (topic.status === 'dropped' || topic.status === 'shipped') next = 'realizing';
  else next = 'ready';
  if (next === topic.status) return topic;
  return updateTopic(topicId, {
    status: next,
    ...(next === 'ready' && !topic.readyAt ? { readyAt: new Date().toISOString() } : {}),
  });
}

// ---------------------------------------------------------------------------
// Develop runs (one session → one repo → one PR)
// ---------------------------------------------------------------------------

export function getRunsForIssue(issueId: number): DevelopRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM develop_runs WHERE issue_id = ? ORDER BY seq ASC, id ASC')
    .all(issueId) as DevelopRunRow[];
  return rows.map(serializeRun);
}

export function getRun(id: number): DevelopRun | null {
  const row = getDb().prepare('SELECT * FROM develop_runs WHERE id = ?').get(id) as DevelopRunRow | undefined;
  return row ? serializeRun(row) : null;
}

// Creates the run plan for an issue, idempotently: a role that already has a
// run keeps its row (retry must not duplicate or reset completed runs).
export function ensureRuns(
  issueId: number,
  plan: { role: RunRole; repoOwner: string; repoName: string }[]
): DevelopRun[] {
  const db = getDb();
  for (const entry of plan) {
    const existing = db
      .prepare('SELECT id FROM develop_runs WHERE issue_id = ? AND role = ?')
      .get(issueId, entry.role);
    if (existing) continue;
    const seqRow = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max FROM develop_runs WHERE issue_id = ?')
      .get(issueId) as { max: number };
    db.prepare(
      `INSERT INTO develop_runs (issue_id, seq, role, repo_owner, repo_name) VALUES (?, ?, ?, ?, ?)`
    ).run(issueId, seqRow.max + 1, entry.role, entry.repoOwner, entry.repoName);
  }
  return getRunsForIssue(issueId);
}

export interface RunPatch {
  state?: RunState;
  sessionId?: string | null;
  prUrl?: string | null;
  resultText?: string | null;
  blockedReason?: string | null;
}

export function updateRun(id: number, patch: RunPatch): DevelopRun | null {
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  if (patch.state !== undefined) { sets.push('state = ?'); args.push(patch.state); }
  if (patch.sessionId !== undefined) { sets.push('session_id = ?'); args.push(patch.sessionId); }
  if (patch.prUrl !== undefined) { sets.push('pr_url = ?'); args.push(patch.prUrl); }
  if (patch.resultText !== undefined) { sets.push('result_text = ?'); args.push(patch.resultText); }
  if (patch.blockedReason !== undefined) { sets.push('blocked_reason = ?'); args.push(patch.blockedReason); }
  args.push(id);
  getDb().prepare(`UPDATE develop_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getRun(id);
}

// ---------------------------------------------------------------------------
// Issue assignment + scope (metadata only; board moves stay in transitions.ts)
// ---------------------------------------------------------------------------

export interface IssueAssignment {
  projectId?: number | null;
  topicId?: number | null;
}

export function assignIssue(id: number, assignment: IssueAssignment): Issue | null {
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  if (assignment.projectId !== undefined) { sets.push('project_id = ?'); args.push(assignment.projectId); }
  if (assignment.topicId !== undefined) { sets.push('topic_id = ?'); args.push(assignment.topicId); }
  if (sets.length > 0) {
    args.push(id);
    getDb().prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  return getIssue(id);
}

export function setIssueScope(id: number, scope: RepoScope, infraFirst: boolean): Issue | null {
  getDb()
    .prepare(`UPDATE issues SET repo_scope = ?, infra_first = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(scope, infraFirst ? 1 : 0, id);
  return getIssue(id);
}
