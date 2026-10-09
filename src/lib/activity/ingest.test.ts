import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBatch, safeEqual } from './ingest';

const tmpDb = path.join(os.tmpdir(), `devhub-activity-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const store = await import('./store');
const core = await import('../store');

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

describe('safeEqual', () => {
  it('is true for identical secrets and false otherwise', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('parseBatch', () => {
  it('rejects a non-object or blank source', () => {
    expect(parseBatch(null)).toBeNull();
    expect(parseBatch('nope')).toBeNull();
    expect(parseBatch({})).toBeNull();
    expect(parseBatch({ source: '   ' })).toBeNull();
  });

  it('keeps valid sessions and drops malformed ones', () => {
    const batch = parseBatch({
      source: 'laptop',
      sentAt: 5,
      sessions: [
        { harness: 'claude', sessionId: 's1', status: 'working', tokens: { input: 10, bogus: 1 } },
        { harness: 'opencode' },
        'junk',
      ],
      events: [{ sessionId: 's1', ts: 1, type: 'tool', tool: 'edit' }, { sessionId: 's1' }],
    });
    expect(batch?.source).toBe('laptop');
    expect(batch?.sessions).toHaveLength(1);
    expect(batch?.sessions?.[0].tokens).toEqual({ input: 10 });
    expect(batch?.events).toHaveLength(1);
  });

  it('defaults unknown harness/status to opencode/idle', () => {
    const batch = parseBatch({ source: 'laptop', sessions: [{ sessionId: 's1' }] });
    expect(batch?.sessions?.[0].harness).toBe('opencode');
    expect(batch?.sessions?.[0].status).toBe('idle');
  });
});

describe('activity store merge', () => {
  it('keeps the newest updatedAt per session (idempotent replay)', () => {
    store.upsertActivitySessions('laptop', [
      { harness: 'claude', sessionId: 'a', status: 'working', updatedAt: 200, activity: 'newer' },
    ]);
    store.upsertActivitySessions('laptop', [
      { harness: 'claude', sessionId: 'a', status: 'idle', updatedAt: 100, activity: 'stale' },
    ]);
    const fleet = store.getActivityFleet();
    let a = fleet.find((s) => s.sessionId === 'a');
    expect(a?.activity).toBe('newer');
    expect(a?.status).toBe('working');

    store.upsertActivitySessions('laptop', [
      { harness: 'claude', sessionId: 'a', status: 'done', updatedAt: 300, activity: 'newest' },
    ]);
    a = store.getActivityFleet().find((s) => s.sessionId === 'a');
    expect(a?.activity).toBe('newest');
    expect(a?.status).toBe('done');
  });

  it('dedupes events on (source, sessionId, ts, type)', () => {
    const ev = { sessionId: 'a', ts: 1, type: 'tool', tool: 'edit' };
    expect(store.appendActivityEvents('laptop', [ev])).toBe(1);
    expect(store.appendActivityEvents('laptop', [ev])).toBe(0);
    expect(store.getActivityEvents().length).toBe(1);
  });

  it('records a heartbeat and stores history if present', () => {
    store.recordActivityHeartbeat('laptop', 1234, null, { days: [1, 2] });
    const state = store.getActivitySourceState('laptop');
    expect(state?.sentAt).toBe(1234);
    expect(state?.history).toEqual({ days: [1, 2] });
    // history is preserved when a later batch omits it
    store.recordActivityHeartbeat('laptop', 2345, null, undefined);
    expect(store.getActivitySourceState('laptop')?.history).toEqual({ days: [1, 2] });
  });

  it('persists across reconnects (migration)', () => {
    core.closeDbForTests();
    expect(store.getActivityFleet().find((s) => s.sessionId === 'a')?.status).toBe('done');
  });
});
