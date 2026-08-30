import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `devhub-store-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const store = await import('./store.js');

afterAll(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('store', () => {
  it('upserts issues as backlog and skips clobbering in-progress rows', () => {
    store.upsertIssue({
      githubIssueId: 11,
      owner: 'dachrisch',
      repo: 'widget',
      number: 1,
      title: 'First',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/widget/issues/1',
    });
    const list = store.getIssues();
    expect(list).toHaveLength(1);
    const id = list[0].id;

    // Move into an in-progress state; a refresh must not overwrite metadata.
    store.setIssueState(id, 'developing');
    store.upsertIssue({
      githubIssueId: 11,
      owner: 'dachrisch',
      repo: 'widget',
      number: 1,
      title: 'Renamed by GitHub',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/widget/issues/1',
    });
    const mid = store.getIssue(id);
    expect(mid?.title).toBe('First');
    expect(mid?.state).toBe('developing');

    // Back to backlog: refresh is allowed to update metadata again.
    store.setIssueState(id, 'backlog');
    store.upsertIssue({
      githubIssueId: 11,
      owner: 'dachrisch',
      repo: 'widget',
      number: 1,
      title: 'Renamed by GitHub',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/widget/issues/1',
    });
    expect(store.getIssue(id)?.title).toBe('Renamed by GitHub');
  });

  it('records result and events, and appends events in order', () => {
    store.upsertIssue({
      githubIssueId: 12,
      owner: 'bumbleflies',
      repo: 'api',
      number: 7,
      title: 'Do thing',
      body: 'desc',
      htmlUrl: 'https://github.com/bumbleflies/api/issues/7',
    });
    const id = store.getIssueByGithub('bumbleflies', 'api', 7)!.id;
    store.appendEvent(id, 'opencode', { a: 1 });
    store.appendEvent(id, 'opencode', { a: 2 });
    const events = store.getEvents(id);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('opencode');
    expect(events[1].payload).toEqual({ a: 2 });

    store.setResult(id, 'pr', 'https://github.com/bumbleflies/api/pull/42', 'shipped');
    const fin = store.getIssue(id);
    expect(fin?.state).toBe('pr');
    expect(fin?.resultPrUrl).toBe('https://github.com/bumbleflies/api/pull/42');

    store.setLinkedPrUrl(id, 'https://github.com/bumbleflies/api/pull/99');
    const withLinked = store.getIssue(id);
    expect(withLinked?.linkedPrUrl).toBe('https://github.com/bumbleflies/api/pull/99');

    store.setLinkedPrUrl(id, null);
    const cleared = store.getIssue(id);
    expect(cleared?.linkedPrUrl).toBeNull();
  });
});
