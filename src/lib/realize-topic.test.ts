import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-realize-test-${process.pid}.db`);

vi.mock('./develop.js', () => ({
  canDevelop: vi.fn(() => true),
  startWork: vi.fn(),
}));
vi.mock('./promote.js', () => ({ promoteTopicToIssue: vi.fn() }));
vi.mock('./github.js', () => ({ sweepRollouts: vi.fn(async () => ({ rolledOut: 0 })) }));
vi.mock('./sse.js', () => ({ publishIssue: vi.fn(), publishRun: vi.fn(), publishTopic: vi.fn() }));
vi.mock('./auto-merge.js', () => ({ autoMergeAndRelease: vi.fn() }));

const { createTopic, getTopic, getIssue, upsertIssue, assignIssue } = await import('./store.js');
const { realizeTopic } = await import('./realize.js');
const { startWork } = await import('./develop.js');
const { promoteTopicToIssue } = await import('./promote.js');

afterEach(() => {
  vi.mocked(startWork).mockReset();
  vi.mocked(promoteTopicToIssue).mockReset();
});

afterAll(() => {
  for (const f of [process.env.DEVHUB_DB!, `${process.env.DEVHUB_DB}-wal`, `${process.env.DEVHUB_DB}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('realizeTopic failure surfacing', () => {
  it('surfaces a startWork failure as needs-input on the linked issue', async () => {
    const topic = createTopic({ title: 'Idea', status: 'ready' });
    const issue = upsertIssue({
      githubIssueId: 1,
      owner: 'dachrisch',
      repo: 'devhub',
      number: 1,
      title: 'Idea',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/devhub/issues/1',
    });
    assignIssue(issue.id, { topicId: topic.id });
    vi.mocked(startWork).mockRejectedValueOnce(new Error('boom'));

    const outcome = await realizeTopic(topic.id, 'token', { waitTimeoutMs: 100 });

    expect(outcome).toEqual({ mode: 'needs-input' });
    expect(getIssue(issue.id)?.blockedReason).toContain('Realize failed: boom');
  });

  it('rolls the topic back to ready when promotion fails (no linked issue)', async () => {
    const topic = createTopic({ title: 'Idea without repo', status: 'ready' });
    vi.mocked(promoteTopicToIssue).mockRejectedValueOnce(new Error('no service repo'));

    const outcome = await realizeTopic(topic.id, 'token', { waitTimeoutMs: 100 });

    expect(outcome).toEqual({ mode: 'needs-input' });
    expect(getTopic(topic.id)?.status).toBe('ready');
  });
});
