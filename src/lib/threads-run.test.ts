import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `devhub-threads-run-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const store = await import('./store');
const runs = await import('./threads-run');

afterAll(() => {
  store.closeDbForTests();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

beforeEach(() => {
  runs.resetQueueForTests();
});

describe('thread blocked reason', () => {
  test('round-trips via system events without a new column', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Blocked', issueIds: [] });
    expect(runs.getThreadBlockedReason(t.id)).toBeNull();
    runs.markThreadBlocked(t.id, 'planner yielded no strategy');
    expect(runs.getThreadBlockedReason(t.id)).toBe('planner yielded no strategy');
    expect(store.getThread(t.id)?.state).toBe('blocked');
  });

  test('latest blocked event wins', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Blocked twice', issueIds: [] });
    runs.markThreadBlocked(t.id, 'first');
    runs.markThreadBlocked(t.id, 'second');
    expect(runs.getThreadBlockedReason(t.id)).toBe('second');
  });
});

describe('persistClarification', () => {
  test('folds the answer into the issue body and returns the fresh issue', () => {
    const issue = store.createWorkRequest({
      owner: 'dachrisch',
      repo: 'servyy-container',
      title: 'Ofelia scheduler',
      body: 'Which scheduler should run on codey?',
    });
    const updated = runs.persistClarification(issue, 'option a', 'token');
    expect(updated?.body).toContain('## Clarifications');
    expect(updated?.body).toContain('- option a');
    expect(store.getIssue(issue.id)?.body).toContain('- option a');
  });
});

describe('recordPlannerTurn', () => {
  test('appends the turn and returns parsed split items', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Plan', issueIds: [] });
    const items = runs.recordPlannerTurn(
      t.id,
      'Strategy done.\n```json\n[{"repo":"a/b","title":"T","body":"B","why":"W"}]\n```'
    );
    expect(items).toHaveLength(1);
    expect(store.getThreadEvents(t.id).at(-1)?.kind).toBe('agent');
  });

  test('empty planner output blocks the thread', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Empty', issueIds: [] });
    const items = runs.recordPlannerTurn(t.id, '   ');
    expect(items).toEqual([]);
    expect(runs.getThreadBlockedReason(t.id)).toContain('no strategy');
  });
});

describe('serial work queue', () => {
  test('enqueues with visible positions', () => {
    const positions = runs.enqueueWork([5, 6, 7]);
    expect(positions).toEqual([1, 2, 3]);
    expect(runs.getQueuePosition(6)).toBe(2);
    expect(runs.getQueuePosition(999)).toBeNull();
  });

  test('lists positions for the board snapshot', () => {
    runs.enqueueWork([5, 6]);
    expect(runs.listQueuePositions()).toEqual({ 5: 1, 6: 2 });
  });

  test('one pump drains the queue in order, strictly serially', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const gates: Array<() => void> = [];
    runs.setWorkRunner(async (issueId: number) => {
      started.push(issueId);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      finished.push(issueId);
    });
    runs.enqueueWork([5, 6]);
    const draining = runs.pumpWorkQueue();
    await Promise.resolve();
    await Promise.resolve();
    // Only the first run is live; the second has not started.
    expect(started).toEqual([5]);
    expect(runs.getQueuePosition(5)).toBe('live');
    // A concurrent pump while draining is a no-op.
    void runs.pumpWorkQueue();
    expect(started).toEqual([5]);
    // Releasing the first gate lets the second start — never overlapping.
    gates[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([5, 6]);
    expect(finished).toEqual([5]);
    gates[1]();
    await draining;
    expect(finished).toEqual([5, 6]);
    expect(runs.getQueuePosition(5)).toBeNull();
    expect(runs.getQueuePosition(6)).toBeNull();
  });

  test('failed runs do not stall the queue', async () => {
    const started: number[] = [];
    runs.setWorkRunner(async (issueId: number) => {
      started.push(issueId);
      if (issueId === 5) throw new Error('boom');
    });
    runs.enqueueWork([5, 6]);
    await runs.pumpWorkQueue();
    await runs.pumpWorkQueue();
    expect(started).toEqual([5, 6]);
    expect(runs.getQueuePosition(5)).toBeNull();
  });
});

describe('confirmSplit', () => {
  test('creates at most 10 issues and enqueues them', async () => {
    const t = store.createThread({ kind: 'strategy', title: 'Confirm', issueIds: [] });
    const created: string[] = [];
    const items = Array.from({ length: 12 }, (_, i) => ({ repo: 'a/b', title: `t${i}`, body: '', why: '' }));
    const ids = await runs.confirmSplit(t.id, items, {
      createIssue: async (item) => {
        created.push(item.title);
        return 100 + created.length;
      },
    });
    expect(created).toHaveLength(10);
    expect(ids).toHaveLength(10);
    expect(runs.getQueuePosition(ids[0])).toBe(1);
    expect(store.getThread(t.id)?.state).toBe('done');
  });

  test('nothing created until confirm — parse alone enqueues nothing', () => {
    const t = store.createThread({ kind: 'strategy', title: 'No auto-create', issueIds: [] });
    runs.recordPlannerTurn(t.id, '```json\n[{"repo":"a/b","title":"T","body":"","why":""}]\n```');
    expect(runs.getQueuePosition(1)).toBeNull();
    expect(store.getThread(t.id)?.state).not.toBe('done');
  });

  test('recovers the latest split proposal from the last agent turn', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Split', issueIds: [] });
    runs.recordPlannerTurn(t.id, 'strategy thoughts, no proposal');
    runs.recordPlannerTurn(t.id, 'Split time.\n```json\n[{"repo":"a/b","title":"T","body":"B","why":"W"}]\n```');
    const proposal = runs.getLatestSplitProposal(t.id);
    expect(proposal).toHaveLength(1);
    expect(proposal[0].title).toBe('T');
  });

  test('no proposal on thread yields empty', () => {
    const t = store.createThread({ kind: 'strategy', title: 'No split', issueIds: [] });
    runs.recordPlannerTurn(t.id, 'just chatting');
    expect(runs.getLatestSplitProposal(t.id)).toEqual([]);
  });
});
