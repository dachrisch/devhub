// Seeds a DevHub SQLite DB for local/headless development:
//  - a fixed auth session (so headless clients can bypass the GitHub OAuth flow)
//  - generic issues across every board state
// Run standalone: node scripts/dev/seed.mjs   (uses DEVHUB_DB, default ./.devhub-dev.db)
'use strict';

import Database from 'better-sqlite3';

export const DEV_SESSION_ID = 'dev-headless-session-0001';
export const DEV_SESSION_TOKEN = 'mock-token';
export const DEV_USER = { login: 'octocat', avatarUrl: null };

const SESSION_TTL_DAYS = 30;

// Same shape as src/lib/store.ts migrate(). The app's own migration is
// idempotent (CREATE TABLE IF NOT EXISTS) and adds any newer columns.
const DDL = `
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
    blocked_reason TEXT,
    linked_pr_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    release_tag TEXT,
    released_at TEXT,
    model_id TEXT,
    UNIQUE(owner, repo, number)
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    login TEXT NOT NULL,
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`;

// owner/repo/number mirror scripts/dev/mock-github.cjs so refresh() syncs
// metadata of backlog rows instead of creating duplicates. Non-backlog rows
// are never touched by refresh (store.ts upsertIssue).
const ISSUES = [
  { owner: 'dachrisch', repo: 'devhub', number: 101, title: 'Polish board card hover states', state: 'backlog' },
  { owner: 'dachrisch', repo: 'devhub', number: 102, title: 'Add keyboard shortcut cheat sheet', state: 'backlog' },
  { owner: 'dachrisch', repo: 'devhub', number: 103, title: 'Cache model list for 5 minutes', state: 'refinement' },
  { owner: 'dachrisch', repo: 'devhub', number: 104, title: 'Improve SSE reconnect backoff', state: 'developing', session: 'dev-mock-session' },
  // devhub#132: failed develop runs stay in `developing` with a reason — this
  // row is the "Work retries a failed run" fixture.
  { owner: 'dachrisch', repo: 'devhub', number: 105, title: 'Trim log noise in develop runs', state: 'developing', blockedReason: 'CANNOT FULFILL: simulated previous run failure (seeded retry fixture)' },
  { owner: 'dachrisch', repo: 'devhub', number: 106, title: 'Support repo filter on mobile search', state: 'pr', pr: 'https://github.com/dachrisch/devhub/pull/206', resultText: 'All done. Let me provide the summary.\n\n## Summary\n\nImplemented the repo filter for mobile search:\n\n- **`src/components/board/mobile-search-sheet.tsx`** — new `repo:` token in the query parser\n- **`src/lib/board-ui.ts`** — `matchesIssue` now filters on `issue.repo`\n\n```ts\nconst repos = new Set(issues.map((i) => `${i.owner}/${i.repo}`));\n```\n\nOpened PR #206: https://github.com/dachrisch/devhub/pull/206' },
  { owner: 'dachrisch', repo: 'devhub', number: 99, title: 'Ship WAL checkpoint tuning', state: 'rollout', releaseTag: 'v1.11.0', resultText: '## Released\n\nWAL checkpoint tuning shipped in **v1.11.0**:\n\n1. Lower `wal_autocheckpoint` to 512 pages\n2. Run `PRAGMA wal_checkpoint(TRUNCATE)` on a timer' },
  { owner: 'bumbleflies', repo: 'warehouse', number: 101, title: 'Polish board card hover states', state: 'backlog' },
  { owner: 'bumbleflies', repo: 'warehouse', number: 102, title: 'Add keyboard shortcut cheat sheet', state: 'backlog' },
  { owner: 'bumbleflies', repo: 'warehouse', number: 103, title: 'Cache model list for 5 minutes', state: 'backlog' },
];

export function seedDevDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(DDL);

  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  db.prepare(
    `INSERT INTO auth_sessions (id, token, login, avatar_url, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`
  ).run(DEV_SESSION_ID, DEV_SESSION_TOKEN, DEV_USER.login, DEV_USER.avatarUrl, expires);

  const insert = db.prepare(
    `INSERT INTO issues (github_issue_id, owner, repo, number, title, body, html_url, state,
                         session_id, result_pr_url, result_text, blocked_reason, release_tag)
     VALUES (@githubIssueId, @owner, @repo, @number, @title, @body, @htmlUrl, @state,
             @sessionId, @prUrl, @resultText, @blockedReason, @releaseTag)
     ON CONFLICT(owner, repo, number) DO UPDATE SET
       title = excluded.title, state = excluded.state,
       session_id = excluded.session_id, result_pr_url = excluded.result_pr_url,
       result_text = excluded.result_text, blocked_reason = excluded.blocked_reason,
       release_tag = excluded.release_tag,
       updated_at = datetime('now')
     WHERE state = 'backlog'`
  );

  const count = db.transaction(() => {
    let n = 0;
    for (const i of ISSUES) {
      insert.run({
        githubIssueId: 900000 + i.number,
        owner: i.owner,
        repo: i.repo,
        number: i.number,
        title: i.title,
        body: 'Generic mock issue body for local development.',
        htmlUrl: `https://github.com/${i.owner}/${i.repo}/issues/${i.number}`,
        state: i.state,
        sessionId: i.session ?? null,
        prUrl: i.pr ?? null,
        resultText: i.session ? 'Mock develop run in progress.' : (i.resultText ?? null),
        blockedReason: i.blockedReason ?? null,
        releaseTag: i.releaseTag ?? null,
      });
      n++;
    }
    return n;
  })();

  db.close();
  return { session: DEV_SESSION_ID, issues: count };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const dbPath = process.env.DEVHUB_DB ?? './.devhub-dev.db';
  const result = seedDevDb(dbPath);
  console.log(`[seed] db=${dbPath} session=${result.session} issues=${result.issues}`);
}
