import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-gh-test-${process.pid}.db`);
process.env.GITHUB_TOPICS = 'bumbleflies,dachrisch';
process.env.GITHUB_ALLOWED_ORG = 'bumbleflies';

const {
  repoMatchesTopics,
  isPullRequest,
  isBotIssue,
  isAllowedMember,
  refreshIssues,
  sweepRollouts,
  setIssueStateLabels,
  commentOnIssue,
} = await import('./github.js');
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
      if (url.includes('/user/repos')) {
        return ghResponse([
          { name: 'matched', full_name: 'dachrisch/matched', owner: { login: 'dachrisch' }, topics: ['dachrisch'] },
          { name: 'other', full_name: 'dachrisch/other', owner: { login: 'dachrisch' }, topics: ['unrelated'] },
          { name: 'bee', full_name: 'bumbleflies/bee', owner: { login: 'bumbleflies' }, topics: ['bumbleflies'] },
        ])();
      }
      if (url.includes('/dachrisch/matched/issues') && !url.includes('/search')) {
        return ghResponse([
          { id: 101, number: 1, title: 'real issue', body: 'b', html_url: 'u', pull_request: undefined },
          { id: 102, number: 2, title: 'a PR', body: null, html_url: 'u', pull_request: {} },
          { id: 103, number: 3, title: 'Dependency Dashboard', body: null, html_url: 'u', user: { login: 'renovate[bot]', type: 'Bot' } },
        ])();
      }
      if (url.includes('/bumbleflies/bee/issues') && !url.includes('/search')) {
        return ghResponse([{ id: 201, number: 3, title: 'org issue', body: null, html_url: 'u' }])();
      }
      if (url.includes('/search/issues')) {
        return ghResponse({ total_count: 0, items: [] })();
      }
      return ghResponse([])();
    }) as unknown as typeof fetch;

    const result = await refreshIssues('token-abc', fetchFn);
    expect(result.repos).toBe(2);
    expect(result.issues).toBe(2);

    expect(store.getIssueByGithub('dachrisch', 'matched', 1)?.title).toBe('real issue');
    expect(store.getIssueByGithub('dachrisch', 'matched', 2)).toBeNull(); // PR skipped
    expect(store.getIssueByGithub('dachrisch', 'matched', 3)).toBeNull(); // bot issue skipped
    expect(store.getIssueByGithub('bumbleflies', 'bee', 3)?.title).toBe('org issue');
  });

  it('fetches linked PRs for issues', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/user/repos')) {
        return ghResponse([
          { name: 'repo', full_name: 'test/repo', owner: { login: 'test' }, topics: ['dachrisch'] },
        ])();
      }
      if (url.includes('/test/repo/issues') && !url.includes('/search')) {
        return ghResponse([
          { id: 301, number: 5, title: 'issue with PR', body: null, html_url: 'u' },
          { id: 302, number: 6, title: 'issue without PR', body: null, html_url: 'u' },
        ])();
      }
      if (url.includes('/search/issues')) {
        const decoded = decodeURIComponent(url);
        if (decoded.includes('repo:test/repo 5')) {
          return ghResponse({
            total_count: 1,
            items: [{ html_url: 'https://github.com/test/repo/pull/10', pull_request: {} }],
          })();
        }
        return ghResponse({ total_count: 0, items: [] })();
      }
      return ghResponse({ total_count: 0, items: [] })();
    }) as unknown as typeof fetch;

    await refreshIssues('token-abc', fetchFn);

    const issue1 = store.getIssueByGithub('test', 'repo', 5);
    expect(issue1?.linkedPrUrl).toBe('https://github.com/test/repo/pull/10');

    const issue2 = store.getIssueByGithub('test', 'repo', 6);
    expect(issue2?.linkedPrUrl).toBeNull();
  });

  it('reports no repos when the user cannot access matching org repos', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/user/repos')) return ghResponse([])();
      return ghResponse([])();
    }) as unknown as typeof fetch;
    const result = await refreshIssues('token-abc', fetchFn);
    expect(result).toEqual({ repos: 0, issues: 0, rolledOut: 0 });
  });
});

describe('sweepRollouts', () => {
  function makePrIssue(): number {
    store.upsertIssue({
      githubIssueId: 500,
      owner: 'dachrisch',
      repo: 'matched',
      number: 9,
      title: 'merged & tagged',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/matched/issues/9',
    });
    const issue = store.getIssueByGithub('dachrisch', 'matched', 9)!;
    store.setResult(issue.id, 'pr', 'https://github.com/dachrisch/matched/pull/42', 'shipped');
    return issue.id;
  }

  function ghResponse(body: unknown) {
    return async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    });
  }

  it('advances a merged + tagged PR to rollout', async () => {
    const id = makePrIssue();
    const fetchFn = (async (url: string, init?: { method?: string }) => {
      if (url.includes('/pulls/42')) return ghResponse({ merged: true, merge_commit_sha: 'abc123' })();
      if (url.includes('/tags')) {
        return ghResponse([{ name: 'v1.4.0', commit: { sha: 'def456' } }, { name: 'v1.3.0', commit: { sha: 'old' } }])();
      }
      if (url.includes('/compare/abc123')) return ghResponse({ status: 'ahead' })();
      return ghResponse(init?.method === 'GET' ? { labels: [] } : {})();
    }) as unknown as typeof fetch;

    expect(await sweepRollouts('token-abc', fetchFn)).toBe(1);
    const updated = store.getIssue(id);
    expect(updated?.state).toBe('rollout');
    expect(updated?.releaseTag).toBe('v1.4.0');
    expect(updated?.releasedAt).toBeTruthy();
  });

  it('leaves an unmerged PR in pr', async () => {
    const id = makePrIssue();
    const fetchFn = (async (url: string) => {
      if (url.includes('/pulls/42')) return ghResponse({ merged: false, merge_commit_sha: null })();
      return ghResponse([])();
    }) as unknown as typeof fetch;

    expect(await sweepRollouts('token-abc', fetchFn)).toBe(0);
    expect(store.getIssue(id)?.state).toBe('pr');
  });

  it('leaves a merged but untagged PR in pr', async () => {
    const id = makePrIssue();
    const fetchFn = (async (url: string) => {
      if (url.includes('/pulls/42')) return ghResponse({ merged: true, merge_commit_sha: 'abc123' })();
      if (url.includes('/tags')) {
        return ghResponse([{ name: 'v1.2.0', commit: { sha: 'old' } }])();
      }
      if (url.includes('/compare/abc123')) return ghResponse({ status: 'behind' })();
      return ghResponse([])();
    }) as unknown as typeof fetch;

    expect(await sweepRollouts('token-abc', fetchFn)).toBe(0);
    expect(store.getIssue(id)?.state).toBe('pr');
  });
});

describe('isAllowedMember', () => {
  it('accepts a member of the allowed org', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/user/orgs')) return ghResponse([{ login: 'other' }, { login: 'bumbleflies' }])();
      return ghResponse([])();
    }) as unknown as typeof fetch;
    expect(await isAllowedMember('token-abc', fetchFn)).toBe(true);
  });

  it('rejects a non-member', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/user/orgs')) return ghResponse([{ login: 'other' }])();
      return ghResponse([])();
    }) as unknown as typeof fetch;
    expect(await isAllowedMember('token-abc', fetchFn)).toBe(false);
  });

  it('retries a transient GitHub failure before giving up', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new Error('TLS handshake timeout');
      return ghResponse([{ login: 'bumbleflies' }])();
    }) as unknown as typeof fetch;
    expect(await isAllowedMember('token-abc', fetchFn)).toBe(true);
    expect(calls).toBe(2);
  });

  it('throws when the org check keeps failing', async () => {
    const fetchFn = (async () => {
      throw new Error('GitHub request failed (500): https://api.github.com/user/orgs');
    }) as unknown as typeof fetch;
    await expect(isAllowedMember('token-abc', fetchFn)).rejects.toThrow('GitHub request failed (500)');
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

    await setIssueStateLabels('dachrisch', 'matched', 1, 'developing', 'token-abc', fetchFn);
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

    await commentOnIssue('dachrisch', 'matched', 1, 'hello'.padEnd(70000, 'x'), 'token-abc', fetchFn);
    const parsed = JSON.parse(body);
    expect(parsed.body.length).toBe(60000);
  });
});
