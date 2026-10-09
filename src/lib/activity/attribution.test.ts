import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivitySession } from './types';

const tmpDb = path.join(os.tmpdir(), `devhub-activity-attr-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const core = await import('../store');
const attribution = await import('./attribution');

function seed(db: ReturnType<typeof core.getDb>): void {
  db.prepare(
    `INSERT INTO issues (github_issue_id, owner, repo, number, title, html_url, state, session_id, model_id)
     VALUES (1, 'o', 'r', 7, 't', 'http://x', 'developing', 'sess_issue', 'm/issue-model')`
  ).run();
  db.prepare(
    `INSERT INTO develop_runs (issue_id, seq, role, repo_owner, repo_name, state, session_id)
     VALUES (1, 1, 'develop', 'o', 'r', 'developing', 'sess_run')`
  ).run();
  db.prepare(`INSERT INTO threads (kind, title, state, session_id, issue_ids) VALUES ('strategy', 't', 'planning', 'sess_thread', '[7]')`).run();
  db.prepare(`INSERT INTO actions (input, session_ids) VALUES ('x', '["sess_action"]')`).run();
}

function session(over: Partial<ActivitySession>): ActivitySession {
  return {
    source: 'opencode-web',
    sessionId: 'unknown',
    harness: 'opencode',
    project: null,
    repo: null,
    branch: null,
    model: null,
    agent: null,
    status: 'working',
    activity: null,
    startedAt: null,
    updatedAt: null,
    tokens: {},
    cost: null,
    costKind: 'reported',
    messages: 0,
    toolCalls: 0,
    client: null,
    issueId: null,
    attribution: null,
    lastSeen: '',
    ...over,
  };
}

afterAll(() => {
  core.closeDbForTests();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('attribution', () => {
  it('maps session ids from issues, threads, actions, and develop_runs', () => {
    seed(core.getDb());
    const map = attribution.buildAttributionMap();

    expect(map.get('sess_issue')).toMatchObject({ client: 'devhub', issueId: 1, repo: 'o/r', model: 'm/issue-model' });
    expect(map.get('sess_thread')).toMatchObject({ client: 'devhub', issueId: 7, role: 'planner' });
    expect(map.get('sess_action')).toMatchObject({ client: 'devhub', issueId: null });
    expect(map.get('sess_run')).toMatchObject({ client: 'devhub', issueId: 1, repo: 'o/r', role: 'develop' });
  });

  it('attributes a matched session to devhub and fills repo/model', () => {
    const map = attribution.buildAttributionMap();
    const out = attribution.attributeSession(session({ sessionId: 'sess_run' }), map);
    expect(out.client).toBe('devhub');
    expect(out.issueId).toBe(1);
    expect(out.repo).toBe('o/r');
  });

  it('labels unmatched sessions by source', () => {
    expect(attribution.attributeSession(session({ sessionId: 'nope', source: 'opencode-web' }), new Map()).client).toBe(
      'web/API (unattributed)'
    );
    expect(
      attribution.attributeSession(session({ sessionId: 'nope', source: 'laptop', harness: 'claude' }), new Map()).client
    ).toBe('claude-local');
    expect(
      attribution.attributeSession(session({ sessionId: 'nope', source: 'laptop', harness: 'opencode' }), new Map()).client
    ).toBe('opencode-local');
  });
});
