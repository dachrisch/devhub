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

  it('persists the global default model in settings', () => {
    expect(store.getDefaultModel()).toBeNull();
    store.setDefaultModel({ id: 'mimo-v2.5-free', providerID: 'opencode' });
    expect(store.getDefaultModel()).toEqual({ id: 'mimo-v2.5-free', providerID: 'opencode' });
    store.setDefaultModel(null);
    expect(store.getDefaultModel()).toBeNull();
  });

  it('marks a merged + tagged issue as rollout', () => {
    store.upsertIssue({
      githubIssueId: 13,
      owner: 'bumbleflies',
      repo: 'api',
      number: 8,
      title: 'Release me',
      body: null,
      htmlUrl: 'https://github.com/bumbleflies/api/issues/8',
    });
    const id = store.getIssueByGithub('bumbleflies', 'api', 8)!.id;
    store.setResult(id, 'pr', 'https://github.com/bumbleflies/api/pull/77', 'shipped');
    store.setRollout(id, 'v1.5.0');
    const rolled = store.getIssue(id);
    expect(rolled?.state).toBe('rollout');
    expect(rolled?.releaseTag).toBe('v1.5.0');
    expect(rolled?.releasedAt).toBeTruthy();
  });

  it('recovers issues stuck in developing state', () => {
    store.upsertIssue({
      githubIssueId: 20,
      owner: 'dachrisch',
      repo: 'servyy-container',
      number: 91,
      title: 'Stuck issue',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/servyy-container/issues/91',
    });
    const id = store.getIssueByGithub('dachrisch', 'servyy-container', 91)!.id;
    store.setIssueState(id, 'developing');
    store.setSessionId(id, 'ses_old_session');

    const recovered = store.recoverStuckDeveloping();
    expect(recovered).toBe(1);

    const issue = store.getIssue(id);
    expect(issue?.state).toBe('blocked');
    expect(issue?.sessionId).toBeNull();
    expect(issue?.resultText).toContain('recovered');

    const events = store.getEvents(id);
    expect(events.some(e => e.kind === 'recovery')).toBe(true);
  });

  it('exposes the migration-added rollout columns on every issue', () => {
    store.upsertIssue({
      githubIssueId: 14,
      owner: 'dachrisch',
      repo: 'cli',
      number: 2,
      title: 'Plain card',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/cli/issues/2',
    });
    const issue = store.getIssueByGithub('dachrisch', 'cli', 2)!;
    expect(issue.releaseTag).toBeNull();
    expect(issue.releasedAt).toBeNull();
    expect(issue.stateReason).toBeNull();
  });

  it('marks a card closed with a GitHub state reason and reopens it', () => {
    store.upsertIssue({
      githubIssueId: 15,
      owner: 'dachrisch',
      repo: 'cli',
      number: 3,
      title: 'Closed outside the pipeline',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/cli/issues/3',
    });
    const id = store.getIssueByGithub('dachrisch', 'cli', 3)!.id;

    const closed = store.setClosed(id, 'not_planned');
    expect(closed?.state).toBe('closed');
    expect(closed?.stateReason).toBe('not_planned');

    const reopened = store.reopenIssue(id);
    expect(reopened?.state).toBe('backlog');
    expect(reopened?.stateReason).toBeNull();
  });

  it('upsert refresh is allowed again on a closed card (reopen picks up metadata)', () => {
    store.upsertIssue({
      githubIssueId: 16,
      owner: 'dachrisch',
      repo: 'cli',
      number: 4,
      title: 'Before',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/cli/issues/4',
    });
    const id = store.getIssueByGithub('dachrisch', 'cli', 4)!.id;
    store.setClosed(id, 'completed');

    store.upsertIssue({
      githubIssueId: 16,
      owner: 'dachrisch',
      repo: 'cli',
      number: 4,
      title: 'Renamed after reopen',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/cli/issues/4',
    });
    expect(store.getIssue(id)?.title).toBe('Renamed after reopen');
  });
});

describe('actions', () => {
  it('appends and retrieves actions', () => {
    const action = store.appendAction('Launch a new API', 'launch', { name: 'blog-api' });
    expect(action.id).toBeGreaterThan(0);
    expect(action.input).toBe('Launch a new API');
    expect(action.action).toBe('launch');
    expect(action.status).toBe('pending');

    store.setActionStatus(action.id, 'running');
    const updated = store.getAction(action.id);
    expect(updated?.status).toBe('running');

    store.setActionStatus(action.id, 'success', 'Deployed', 5000);
    const done = store.getAction(action.id);
    expect(done?.status).toBe('success');
    expect(done?.result).toBe('Deployed');
    expect(done?.durationMs).toBe(5000);
  });

  it('lists recent actions', () => {
    store.appendAction('action-a', 'launch', {});
    store.appendAction('action-b', 'fix', {});
    const list = store.getActions(5);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
