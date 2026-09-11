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

    // The card stays in `developing` (devhub#132) with a blocked_reason so a
    // "Work" click can resume it.
    const issue = store.getIssue(id);
    expect(issue?.state).toBe('developing');
    expect(issue?.blockedReason).toContain('Server restart interrupted');
    expect(issue?.sessionId).toBeNull();

    const events = store.getEvents(id);
    expect(events.some(e => e.kind === 'recovery')).toBe(true);
  });

  it('sets, clears and surfaces the blocked reason without changing state', () => {
    store.upsertIssue({
      githubIssueId: 21,
      owner: 'dachrisch',
      repo: 'cli',
      number: 3,
      title: 'Needs input',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/cli/issues/3',
    });
    const id = store.getIssueByGithub('dachrisch', 'cli', 3)!.id;

    const blocked = store.setBlockedReason(id, 'Which auth flow?');
    expect(blocked?.state).toBe('backlog');
    expect(blocked?.blockedReason).toBe('Which auth flow?');

    const cleared = store.clearBlockedReason(id);
    expect(cleared?.blockedReason).toBeNull();
  });

  it('migrates legacy blocked rows to backlog with the reason preserved', () => {
    store.upsertIssue({
      githubIssueId: 22,
      owner: 'dachrisch',
      repo: 'legacy',
      number: 4,
      title: 'Legacy blocked',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/legacy/issues/4',
    });
    const id = store.getIssueByGithub('dachrisch', 'legacy', 4)!.id;

    // Simulate a row written by the pre-#132 schema.
    store.getDb()
      .prepare(`UPDATE issues SET state = 'blocked', result_text = 'CANNOT FULFILL: no tests' WHERE id = ?`)
      .run(id);

    // Reopening the DB re-runs migrate(); the blocked row must be re-admitted.
    store.closeDbForTests();
    const fresh = store.getIssue(id);
    expect(fresh?.state).toBe('backlog');
    expect(fresh?.blockedReason).toBe('Previous attempt: CANNOT FULFILL: no tests');
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

  it('persists the transcript on the row but keeps it out of list payloads', () => {
    const action = store.appendAction('transcript-me', 'launch', {});
    store.setActionTranscript(action.id, 'line one\nline two');
    const one = store.getAction(action.id);
    expect(one?.transcript).toBe('line one\nline two');

    const list = store.getActions(50);
    expect(list.find((r) => r.id === action.id)?.transcript).toBeNull();
  });
});

describe('projects & topics (devhub#167)', () => {
  it('seeds projects from the legacy services table on migrate', () => {
    store.getDb().prepare(
      `INSERT INTO services (name, repo_owner, repo_name, deploy_host, deploy_dir, domain, config)
       VALUES ('seed-svc', 'acme', 'seed-repo', 'h', '/d', 'seed-svc.h', '{"framework":"node"}')
       ON CONFLICT(name) DO UPDATE SET repo_owner = excluded.repo_owner`
    ).run();
    store.closeDbForTests();
    const seeded = store.getProjectByName('seed-svc');
    expect(seeded).toBeTruthy();
    expect(seeded?.serviceRepoOwner).toBe('acme');
    expect(seeded?.serviceRepoName).toBe('seed-repo');
    expect(seeded?.domain).toBe('seed-svc.h');
  });

  it('auto-assigns unassigned issues on migrate and resolves repo to project', () => {
    const project = store.ensureProjectForRepo('acme', 'widget-repo');
    expect(project).toBeTruthy();
    store.upsertIssue({
      githubIssueId: 101,
      owner: 'acme',
      repo: 'widget-repo',
      number: 1,
      title: 'Needs assignment',
      body: null,
      htmlUrl: 'https://github.com/acme/widget-repo/issues/1',
    });
    const stored = store.getIssueByGithub('acme', 'widget-repo', 1)!;
    // upsert itself leaves assignment to the ingest/migration pass
    const assigned = store.assignIssue(stored.id, { projectId: project!.id });
    expect(assigned?.projectId).toBe(project!.id);
    expect(store.getIssuesByProject(project!.id).some((i) => i.id === stored.id)).toBe(true);
    // Second sight of the same repo resolves to the same project (no dupes).
    expect(store.ensureProjectForRepo('acme', 'widget-repo')?.id).toBe(project!.id);
  });

  it('auto-creates a skeleton project per unknown repo', () => {
    const skeleton = store.ensureProjectForRepo('neworg', 'brand-new-repo');
    expect(skeleton?.name).toBe('brand-new-repo');
    expect(skeleton?.serviceRepoOwner).toBe('neworg');
    expect(skeleton?.serviceRepoName).toBe('brand-new-repo');
    expect(store.getProjectByRepo('neworg', 'brand-new-repo')?.id).toBe(skeleton!.id);
  });

  it('creates and patches projects, and blocks delete while issues reference it', () => {
    const created = store.createProject({ name: 'proj-crud', domain: 'proj.example.com' });
    expect(created.releaseMode).toBe('tag');
    const patched = store.updateProject(created.id, { statusOverride: 'healthy', releaseMode: 'manual' })!;
    expect(patched.statusOverride).toBe('healthy');
    expect(patched.releaseMode).toBe('manual');

    store.upsertIssue({
      githubIssueId: 102,
      owner: 'acme',
      repo: 'proj-crud-repo',
      number: 2,
      title: 'Linked',
      body: null,
      htmlUrl: 'https://github.com/acme/proj-crud-repo/issues/2',
    });
    const issue = store.getIssueByGithub('acme', 'proj-crud-repo', 2)!;
    store.assignIssue(issue.id, { projectId: created.id });
    const blocked = store.deleteProject(created.id);
    expect(blocked.ok).toBe(false);

    store.assignIssue(issue.id, { projectId: null });
    expect(store.deleteProject(created.id)).toEqual({ ok: true });
    expect(store.getProject(created.id)).toBeNull();
  });

  it('creates, filters, and refreshes topic status from linked issues', () => {
    const project = store.createProject({ name: 'proj-topics' });
    const inbox = store.createTopic({ title: 'Inbox idea' });
    expect(inbox.projectId).toBeNull();
    expect(inbox.status).toBe('new');
    expect(inbox.shapedSummary).toBeNull();
    expect(inbox.mergedIntoTopicId).toBeNull();

    const moved = store.updateTopic(inbox.id, { projectId: project.id, area: 'api' })!;
    expect(moved.projectId).toBe(project.id);
    expect(store.getTopics({ projectId: null }).some((t) => t.id === inbox.id)).toBe(false);
    expect(store.getTopics({ projectId: project.id })).toHaveLength(1);

    store.upsertIssue({
      githubIssueId: 103,
      owner: 'acme',
      repo: 'topic-repo',
      number: 3,
      title: 'Topic work',
      body: null,
      htmlUrl: 'https://github.com/acme/topic-repo/issues/3',
    });
    const issue = store.getIssueByGithub('acme', 'topic-repo', 3)!;
    store.assignIssue(issue.id, { projectId: project.id, topicId: inbox.id });
    // Fresh promotion (backlog only) reads as ready…
    expect(store.refreshTopicStatus(inbox.id)?.status).toBe('ready');
    // …started work flips the topic to realizing…
    store.setIssueState(issue.id, 'developing');
    expect(store.refreshTopicStatus(inbox.id)?.status).toBe('realizing');
    // …and settling every linked issue ships the topic.
    store.setRollout(issue.id, 'v9.9.9');
    expect(store.refreshTopicStatus(inbox.id)?.status).toBe('shipped');

    store.deleteTopic(inbox.id);
    expect(store.getTopic(inbox.id)).toBeNull();
    expect(store.getIssue(issue.id)?.topicId).toBeNull();
  });

  it('keeps topic status synced automatically as its issue changes state (no explicit refresh call)', () => {
    const project = store.createProject({ name: 'proj-topic-autosync' });
    const topic = store.createTopic({ title: 'Autosync idea' });
    store.updateTopic(topic.id, { projectId: project.id });

    store.upsertIssue({
      githubIssueId: 105,
      owner: 'acme',
      repo: 'autosync-repo',
      number: 5,
      title: 'Autosync work',
      body: null,
      htmlUrl: 'https://github.com/acme/autosync-repo/issues/5',
    });
    const issue = store.getIssueByGithub('acme', 'autosync-repo', 5)!;
    store.assignIssue(issue.id, { projectId: project.id, topicId: topic.id });

    store.setIssueState(issue.id, 'refinement');
    expect(store.getTopic(topic.id)?.status).toBe('realizing');

    store.setResult(issue.id, 'pr', 'https://github.com/acme/autosync-repo/pull/1', 'done');
    expect(store.getTopic(topic.id)?.status).toBe('realizing');

    store.setClosed(issue.id, 'not_planned');
    expect(store.getTopic(topic.id)?.status).toBe('shipped');

    // A reopened terminal topic with live work reads as realizing again (see
    // refreshTopicStatus), not back to ready.
    store.reopenIssue(issue.id);
    expect(store.getTopic(topic.id)?.status).toBe('realizing');
  });

  it('persists issue scope and manages develop runs idempotently', () => {
    store.upsertIssue({
      githubIssueId: 104,
      owner: 'acme',
      repo: 'runs-repo',
      number: 4,
      title: 'Scoped work',
      body: null,
      htmlUrl: 'https://github.com/acme/runs-repo/issues/4',
    });
    const issue = store.getIssueByGithub('acme', 'runs-repo', 4)!;
    expect(store.setIssueScope(issue.id, 'both', true)?.repoScope).toBe('both');
    expect(store.getIssue(issue.id)?.infraFirst).toBe(true);

    const runs = store.ensureRuns(issue.id, [
      { role: 'service', repoOwner: 'acme', repoName: 'runs-repo' },
      { role: 'infra', repoOwner: 'acme', repoName: 'infra-repo' },
    ]);
    expect(runs).toHaveLength(2);
    // Retry must not duplicate or reset completed runs.
    store.updateRun(runs[0].id, { state: 'pr', prUrl: 'https://github.com/acme/runs-repo/pull/1' });
    const again = store.ensureRuns(issue.id, [
      { role: 'service', repoOwner: 'acme', repoName: 'runs-repo' },
      { role: 'infra', repoOwner: 'acme', repoName: 'infra-repo' },
    ]);
    expect(again).toHaveLength(2);
    expect(again.find((r) => r.role === 'service')?.state).toBe('pr');
    expect(store.getRunsForIssue(issue.id).map((r) => r.role).sort()).toEqual(['infra', 'service']);
  });

  it('keeps new|shaping|ready topics untouched when they have no linked issues', () => {
    const shaping = store.createTopic({ title: 'Shaping idea', status: 'shaping' });
    const ready = store.createTopic({ title: 'Ready idea', status: 'ready' });
    expect(store.refreshTopicStatus(shaping.id)?.status).toBe('shaping');
    expect(store.refreshTopicStatus(ready.id)?.status).toBe('ready');
  });

  it('links duplicates via mergeTopic (dropped + winner pointer)', () => {
    const winner = store.createTopic({ title: 'Winner idea' });
    const loser = store.createTopic({ title: 'Duplicate idea' });
    const merged = store.mergeTopic(loser.id, winner.id)!;
    expect(merged.status).toBe('dropped');
    expect(merged.mergedIntoTopicId).toBe(winner.id);
    expect(store.getTopic(loser.id)?.mergedIntoTopicId).toBe(winner.id);
    expect(store.mergeTopic(loser.id, loser.id)).toBeNull();
  });

  it('persists shaped summaries and per-project auto_merge', () => {
    const project = store.createProject({ name: 'proj-phase1', autoMerge: false });
    expect(project.autoMerge).toBe(false);
    expect(store.updateProject(project.id, { autoMerge: true })?.autoMerge).toBe(true);

    const topic = store.createTopic({ title: 'Shaped', shapedSummary: 'So far: fast sync' });
    expect(topic.shapedSummary).toBe('So far: fast sync');
    expect(store.updateTopic(topic.id, { shapedSummary: 'So far: faster' })?.shapedSummary).toBe(
      'So far: faster'
    );
    expect(store.getActiveTopicsForProject(project.id)).toHaveLength(0);
    const assigned = store.updateTopic(topic.id, { projectId: project.id })!;
    expect(assigned.projectId).toBe(project.id);
    expect(store.getActiveTopicsForProject(project.id).map((t) => t.id)).toContain(topic.id);
  });

  it('keeps the options thread in order and records picks', () => {
    const topic = store.createTopic({ title: 'Threaded' });
    expect(store.getIdeaMessages(topic.id)).toHaveLength(0);
    const user = store.appendIdeaMessage(topic.id, 'user', 'my idea is sync');
    expect(user.role).toBe('user');
    expect(user.options).toBeNull();
    const hub = store.appendIdeaMessage(topic.id, 'assistant', 'Which way?', [
      { id: 'opt-1', title: 'Light', desc: 'Fast', tradeoff: null },
      { id: 'opt-2', title: 'Full', desc: 'Slow', tradeoff: 'Costly' },
    ]);
    expect(hub.options).toHaveLength(2);
    expect(store.getIdeaMessages(topic.id).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(store.chooseIdeaOption(hub.id, 'opt-2')?.chosenOption).toBe('opt-2');
    expect(store.chooseIdeaOption(hub.id, 'opt-9')).toBeNull();
    store.deleteTopic(topic.id);
    expect(store.getIdeaMessages(topic.id)).toHaveLength(0);
  });
});
