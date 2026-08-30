import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-gh-test-${process.pid}.db`);
process.env.GH_TOKEN = 'pat-dachrisch';
process.env.BUMBLEFLIES_GH_TOKEN = 'pat-bumbleflies';
process.env.GITHUB_TOPICS = 'bumbleflies,dachrisch';

const { repoMatchesTopics, isPullRequest, isBotIssue, refreshIssues, setIssueStateLabels, commentOnIssue } =
  await import('./github.js');
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

  it('detects bot-authored issues', () => {
    expect(isBotIssue({ id: 1, number: 1, title: 't', html_url: 'u', user: { login: 'renovate[bot]', type: 'Bot' } } as never)).toBe(true);
    expect(isBotIssue({ id: 1, number: 1, title: 't', html_url: 'u', user: { login: 'dependabot[bot]', type: 'Bot' } } as never)).toBe(true);
    expect(isBotIssue({ id: 1, number: 1, title: 't', html_url: 'u', user: { login: 'dachrisch', type: 'User' } } as never)).toBe(false);
    expect(isBotIssue({ id: 1, number: 1, title: 't', html_url: 'u' } as never)).toBe(false);
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
      if (url.includes('/users/dachrisch/repos')) {
        return ghResponse([
          { name: 'matched', full_name: 'dachrisch/matched', owner: { login: 'dachrisch' }, topics: ['dachrisch'] },
          { name: 'other', full_name: 'dachrisch/other', owner: { login: 'dachrisch' }, topics: ['unrelated'] },
        ])();
      }
      if (url.includes('/users/bumbleflies/repos')) {
        return ghResponse([
          { name: 'bee', full_name: 'bumbleflies/bee', owner: { login: 'bumbleflies' }, topics: ['bumbleflies'] },
        ])();
      }
      if (url.includes('/dachrisch/matched/issues')) {
        return ghResponse([
          { id: 101, number: 1, title: 'real issue', body: 'b', html_url: 'u', pull_request: undefined },
          { id: 102, number: 2, title: 'a PR', body: null, html_url: 'u', pull_request: {} },
          { id: 103, number: 3, title: 'Dependency Dashboard', body: null, html_url: 'u', user: { login: 'renovate[bot]', type: 'Bot' } },
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
    expect(store.getIssueByGithub('dachrisch', 'matched', 3)).toBeNull(); // bot issue skipped
    expect(store.getIssueByGithub('bumbleflies', 'bee', 3)?.title).toBe('org issue');
  });
});

describe('github mirroring', () => {
  it('replaces only the devhub: state label, keeping others', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchFn = (async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body });
      if (!init.method || init.method === 'GET') {
        return ghResponse({ labels: [{ name: 'bug' }, { name: 'devhub:backlog' }] })();
      }
      return ghResponse({})();
    }) as unknown as typeof fetch;

    await setIssueStateLabels('dachrisch', 'matched', 1, 'developing', fetchFn);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://api.github.com/repos/dachrisch/matched/issues/1');
    expect(JSON.parse(patch.body!).labels).toEqual(['bug', 'devhub:developing']);
  });

  it('posts a comment, truncating to 60000 chars', async () => {
    let body = '';
    const fetchFn = (async (url: string, init: { method?: string; body?: string }) => {
      if (init.method === 'POST') body = init.body!;
      return ghResponse({})();
    }) as unknown as typeof fetch;

    await commentOnIssue('dachrisch', 'matched', 1, 'hello'.padEnd(70000, 'x'), fetchFn);
    const parsed = JSON.parse(body);
    expect(parsed.body.length).toBe(60000);
  });
});
