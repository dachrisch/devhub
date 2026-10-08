import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `devhub-threads-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const store = await import('./store');

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

describe('threads', () => {
  it('creates a work thread in refining state', () => {
    const t = store.createThread({ kind: 'work', title: 'Implement login', issueIds: [] });
    expect(t.id).toBeGreaterThan(0);
    expect(t.kind).toBe('work');
    expect(t.state).toBe('refining');
    expect(t.title).toBe('Implement login');
    expect(t.issueIds).toEqual([]);
  });

  it('creates a strategy thread in planning state', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Combined plan', issueIds: [] });
    expect(t.kind).toBe('strategy');
    expect(t.state).toBe('planning');
  });

  it('round-trips thread events in order', () => {
    const t = store.createThread({ kind: 'work', title: 'Events', issueIds: [] });
    store.appendThreadEvent(t.id, 'user', 'do the thing');
    store.appendThreadEvent(t.id, 'agent', 'working on it');
    const events = store.getThreadEvents(t.id);
    expect(events.map((e) => e.kind)).toEqual(['user', 'agent']);
    expect(events.map((e) => e.text)).toEqual(['do the thing', 'working on it']);
    expect(events[0].threadId).toBe(t.id);
  });

  it('updates thread state and links issues', () => {
    const t = store.createThread({ kind: 'work', title: 'Link me', issueIds: [] });
    const updated = store.updateThread(t.id, { state: 'developing', issueIds: [7], sessionId: 'ses_1' });
    expect(updated?.state).toBe('developing');
    expect(updated?.issueIds).toEqual([7]);
    expect(updated?.sessionId).toBe('ses_1');
    expect(store.getThread(t.id)?.state).toBe('developing');
  });

  it('lists threads newest-first', () => {
    const a = store.createThread({ kind: 'work', title: 'First thread', issueIds: [] });
    const b = store.createThread({ kind: 'work', title: 'Second thread', issueIds: [] });
    const titles = store.listThreads().map((t) => t.title);
    expect(titles.indexOf(b.title)).toBeLessThan(titles.indexOf(a.title));
  });

  it('persists threads across reconnects (migration)', () => {
    const t = store.createThread({ kind: 'strategy', title: 'Survivor', issueIds: [1, 2] });
    store.closeDbForTests();
    const again = store.getThread(t.id);
    expect(again?.title).toBe('Survivor');
    expect(again?.issueIds).toEqual([1, 2]);
  });
});
