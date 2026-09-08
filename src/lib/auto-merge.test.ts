import { describe, expect, it } from 'vitest';
import { autoMergeAndRelease } from './auto-merge';
import type { DevelopRun } from './types';

function run(prUrl: string | null = 'https://github.com/dachrisch/devhub/pull/999'): DevelopRun {
  return {
    id: 7,
    issueId: 3,
    seq: 1,
    role: 'service',
    repoOwner: 'dachrisch',
    repoName: 'devhub',
    state: 'pr',
    sessionId: null,
    prUrl,
    resultText: null,
    blockedReason: null,
    createdAt: 'now',
    updatedAt: 'now',
  };
}

const TAG_PROJECT = { autoMerge: true, releaseMode: 'tag' as const };
const MANUAL_PROJECT = { autoMerge: true, releaseMode: 'manual' as const };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(handler: (url: string, method: string, body: unknown) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url: u, method, body });
    const { status, body: payload } = handler(u, method, body);
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  }) as typeof fetch;
  return { fetchFn, calls };
}

function greenHandler(extra: Record<string, unknown> = {}) {
  return (url: string, method: string) => {
    if (url.endsWith('/pulls/999') && method === 'GET') {
      return {
        status: 200,
        body: { merged: false, merge_commit_sha: null, mergeable: true, mergeable_state: 'clean', head: { sha: 'abc' }, node_id: 'PR_node', ...extra },
      };
    }
    if (url.includes('/commits/abc/status')) return { status: 200, body: { state: 'success' } };
    if (url.endsWith('/pulls/999/merge')) return { status: 200, body: { merged: true, sha: 'm1' } };
    if (url.endsWith('/git/tags')) return { status: 201, body: { sha: 'tagsha' } };
    if (url.endsWith('/git/refs')) return { status: 201, body: { ref: 'refs/tags/devhub-auto' } };
    if (url.endsWith('/graphql')) return { status: 200, body: { data: {} } };
    return { status: 404, body: {} };
  };
}

describe('autoMergeAndRelease (devhub#171 Phase 4)', () => {
  it('skips when auto-merge is off or the run has no PR', async () => {
    expect((await autoMergeAndRelease(run(), null, 'tok', (async () => { throw new Error('must not call'); }) as never)).outcome).toBe('skipped');
    expect((await autoMergeAndRelease(run(), { autoMerge: false, releaseMode: 'tag' }, 'tok', (async () => { throw new Error('must not call'); }) as never)).outcome).toBe('skipped');
    const { fetchFn } = fakeFetch(() => ({ status: 500, body: {} }));
    expect((await autoMergeAndRelease(run(null), TAG_PROJECT, 'tok', fetchFn)).outcome).toBe('skipped');
  });

  it('squash-merges a green PR and cuts a tag (tag mode)', async () => {
    const { fetchFn, calls } = fakeFetch(greenHandler());
    const out = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', fetchFn);
    expect(out.outcome).toBe('merged');
    expect(out.mergeSha).toBe('m1');
    expect(out.released).toBe(true);
    const merge = calls.find((c) => c.url.endsWith('/pulls/999/merge'));
    expect(merge?.method).toBe('PUT');
    expect((merge?.body as { merge_method?: string })?.merge_method).toBe('squash');
    expect(calls.some((c) => c.url.endsWith('/git/tags') && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/git/refs') && c.method === 'POST')).toBe(true);
  });

  it('skips the tag cut and auto-releases in manual mode', async () => {
    const { fetchFn, calls } = fakeFetch(greenHandler());
    const out = await autoMergeAndRelease(run(), MANUAL_PROJECT, 'tok', fetchFn);
    expect(out.outcome).toBe('merged');
    expect(out.released).toBe(true);
    expect(calls.some((c) => c.url.includes('/git/'))).toBe(false);
  });

  it('goes straight to the release step for an already-merged PR', async () => {
    const { fetchFn, calls } = fakeFetch((url: string, method: string) => {
      if (url.endsWith('/pulls/999') && method === 'GET') {
        return { status: 200, body: { merged: true, merge_commit_sha: 'm9', head: { sha: 'abc' } } };
      }
      if (url.endsWith('/git/tags')) return { status: 201, body: { sha: 'tagsha' } };
      if (url.endsWith('/git/refs')) return { status: 201, body: {} };
      return { status: 404, body: {} };
    });
    const out = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', fetchFn);
    expect(out.outcome).toBe('already-merged');
    expect(out.mergeSha).toBe('m9');
    expect(out.released).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/merge'))).toBe(false);
  });

  it('waits while CI is pending and fails loudly on red checks or conflicts', async () => {
    const pending = fakeFetch((url: string, method: string) => {
      if (url.endsWith('/pulls/999') && method === 'GET') {
        return { status: 200, body: { merged: false, mergeable_state: 'unknown', head: { sha: 'abc' } } };
      }
      if (url.includes('/commits/abc/status')) return { status: 200, body: { state: 'pending' } };
      return { status: 404, body: {} };
    });
    const p = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', pending.fetchFn);
    expect(p.outcome).toBe('pending');
    expect(pending.calls.some((c) => c.url.endsWith('/merge'))).toBe(false);

    const red = fakeFetch((url: string) => {
      if (url.endsWith('/pulls/999')) return { status: 200, body: { merged: false, head: { sha: 'abc' } } };
      if (url.includes('/commits/abc/status')) return { status: 200, body: { state: 'failure' } };
      return { status: 404, body: {} };
    });
    const f = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', red.fetchFn);
    expect(f.outcome).toBe('failed');
    expect(f.reason).toMatch(/CI checks failing/);

    const dirty = fakeFetch((url: string) => {
      if (url.endsWith('/pulls/999')) {
        return { status: 200, body: { merged: false, mergeable: false, mergeable_state: 'dirty', head: { sha: 'abc' } } };
      }
      if (url.includes('/commits/abc/status')) return { status: 200, body: { state: 'success' } };
      return { status: 404, body: {} };
    });
    const d = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', dirty.fetchFn);
    expect(d.outcome).toBe('failed');
    expect(d.reason).toMatch(/merge conflict/);
  });

  it('arms GraphQL auto-merge when direct merge is protection-blocked', async () => {
    const { fetchFn, calls } = fakeFetch((url: string, method: string) => {
      if (url.endsWith('/pulls/999') && method === 'GET') {
        return { status: 200, body: { merged: false, mergeable_state: 'blocked', head: { sha: 'abc' }, node_id: 'PR_node' } };
      }
      if (url.includes('/commits/abc/status')) return { status: 200, body: { state: 'success' } };
      if (url.endsWith('/pulls/999/merge')) return { status: 405, body: { message: 'Required status check' } };
      if (url.endsWith('/graphql')) return { status: 200, body: { data: { enablePullRequestAutoMerge: {} } } };
      return { status: 404, body: {} };
    });
    const out = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', fetchFn);
    expect(out.outcome).toBe('pending');
    expect(out.reason).toMatch(/auto-merge armed/);
    expect(calls.some((c) => c.url.endsWith('/graphql'))).toBe(true);
  });

  it('reports merged-without-release when the tag cut fails (sweep retries)', async () => {
    const { fetchFn } = fakeFetch((url: string, method: string) => {
      if (url.endsWith('/pulls/999') && method === 'GET') {
        return { status: 200, body: { merged: false, mergeable_state: 'clean', head: { sha: 'abc' } } };
      }
      if (url.includes('/commits/abc/status')) return { status: 200, body: { state: 'success' } };
      if (url.endsWith('/pulls/999/merge')) return { status: 200, body: { merged: true, sha: 'm1' } };
      if (url.endsWith('/git/tags')) return { status: 422, body: { message: 'tag exists' } };
      return { status: 404, body: {} };
    });
    const out = await autoMergeAndRelease(run(), TAG_PROJECT, 'tok', fetchFn);
    expect(out.outcome).toBe('merged');
    expect(out.released).toBeUndefined();
    expect(out.reason).toMatch(/tag cut failed/);
  });
});
