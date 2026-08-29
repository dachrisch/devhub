import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-gh-test-${process.pid}.db`);
process.env.GH_TOKEN = 'pat-dachrisch';
process.env.BUMBLEFLIES_GH_TOKEN = 'pat-bumbleflies';
process.env.GITHUB_TOPICS = 'bumbleflies,dachrisch';

const { repoMatchesTopics, isPullRequest, refreshIssues } = await import('./github.js');
const store = await import('./store.js');

afterAll(() => {
  for (const f of [process.env.DEVHUB_DB!, `${process.env.DEVHUB_DB}-wal`, `${process.env.DEVHUB_DB}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('github parsing', () => {
  it('matches repos whose topics intersect the wanted set', () => {
    expect(repoMatchesTopics(['foo', 'dachrisch'], ['bumbleflies', 'dachrisch'])).toBe(true);
    expect(repoMatchesTopics(['foo'], ['bumbleflies', 'dachrisch'])).toBe(false);
    expect(repoMatchesTopics(undefined, ['bumbleflies'])).toBe(false);
  });

  it('detects pull requests', () => {
    expect(isPullRequest({ id: 1, number: 1, title: 't', html_url: 'u', pull_request: {} } as never)).toBe(true);
    expect(isPullRequest({ id: 1, number: 1, title: 't', html_url: 'u' } as never)).toBe(false);
  });
});

function ghResponse(body: unknown) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  });
}

describe('refreshIssues', () => {
  it('ingests matching open issues and skips PRs', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/orgs/dachrisch/repos')) {
        return ghResponse([
          { name: 'matched', full_name: 'dachrisch/matched', owner: { login: 'dachrisch' }, topics: ['dachrisch'] },
          { name: 'other', full_name: 'dachrisch/other', owner: { login: 'dachrisch' }, topics: ['unrelated'] },
        ])();
      }
      if (url.includes('/orgs/bumbleflies/repos')) {
        return ghResponse([
          { name: 'bee', full_name: 'bumbleflies/bee', owner: { login: 'bumbleflies' }, topics: ['bumbleflies'] },
        ])();
      }
      if (url.includes('/dachrisch/matched/issues')) {
        return ghResponse([
          { id: 101, number: 1, title: 'real issue', body: 'b', html_url: 'u', pull_request: undefined },
          { id: 102, number: 2, title: 'a PR', body: null, html_url: 'u', pull_request: {} },
        ])();
      }
      if (url.includes('/bumbleflies/bee/issues')) {
        return ghResponse([{ id: 201, number: 3, title: 'org issue', body: null, html_url: 'u' }])();
      }
      return ghResponse([])();
    }) as unknown as typeof fetch;

    const result = await refreshIssues(fetchFn);
    expect(result.repos).toBe(2);
    expect(result.issues).toBe(2);

    expect(store.getIssueByGithub('dachrisch', 'matched', 1)?.title).toBe('real issue');
    expect(store.getIssueByGithub('dachrisch', 'matched', 2)).toBeNull(); // PR skipped
    expect(store.getIssueByGithub('bumbleflies', 'bee', 3)?.title).toBe('org issue');
  });
});
