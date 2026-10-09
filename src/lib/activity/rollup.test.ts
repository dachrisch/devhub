import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivitySession } from './types';

const tmpDb = path.join(os.tmpdir(), `devhub-activity-rollup-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const core = await import('../store');
const rollup = await import('./rollup');

function session(over: Partial<ActivitySession>): ActivitySession {
  return {
    source: 'opencode-web',
    sessionId: 's',
    harness: 'opencode',
    title: null,
    project: '/p',
    repo: null,
    branch: null,
    model: 'm',
    agent: null,
    status: 'idle',
    activity: null,
    startedAt: null,
    updatedAt: Date.UTC(2026, 0, 2, 10, 0, 0),
    tokens: {},
    cost: null,
    costKind: 'reported',
    messages: 0,
    toolCalls: 0,
    client: 'devhub',
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

describe('usage rollup', () => {
  it('keeps reported and estimated cost separate and sums tokens per day', () => {
    rollup.upsertUsageSessions([
      session({ sessionId: 'a', tokens: { input: 10, output: 2 }, cost: 0.5, costKind: 'reported' }),
      session({
        sessionId: 'b',
        harness: 'claude',
        client: 'claude-local',
        tokens: { input: 5 },
        cost: 0.25,
        costKind: 'estimated',
      }),
    ]);
    rollup.recomputeUsageDaily();
    const h = rollup.getUsageHistory();
    expect(h.days).toHaveLength(1);
    expect(h.days[0]).toMatchObject({ key: '2026-01-02', sessions: 2, tokens: 17 });
    expect(h.days[0].costReported).toBeCloseTo(0.5);
    expect(h.days[0].costEstimated).toBeCloseTo(0.25);
    expect(h.clients.map((c) => c.key).sort()).toEqual(['claude-local', 'devhub']);
  });

  it('refresh is stale-gated and forceable', async () => {
    const t1 = await rollup.refreshUsageRollupsIfStale({ force: true, now: 1_000, opencode: false });
    expect(t1).toBe(true);
    const t2 = await rollup.refreshUsageRollupsIfStale({ now: 1_000 + 60_000, opencode: false });
    expect(t2).toBe(false);
    const t3 = await rollup.refreshUsageRollupsIfStale({ force: true, now: 1_000 + 60_000, opencode: false });
    expect(t3).toBe(true);
  });

  it('history survives after the live/ingested rows are gone (prune)', () => {
    core.getDb().exec('DELETE FROM activity_session');
    rollup.recomputeUsageDaily();
    expect(rollup.getUsageHistory().days[0]).toMatchObject({ key: '2026-01-02', sessions: 2 });
  });
});
