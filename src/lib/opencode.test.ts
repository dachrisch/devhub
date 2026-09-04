import { describe, expect, it, vi } from 'vitest';

const fakeFetch = vi.fn();

vi.mock('undici', () => {
  class Agent {}
  return {
    Agent,
    fetch: (...args: unknown[]) => fakeFetch(...args),
  };
});

const { runDevelop, extractPrUrl, buildDevelopPrompt, defaultModels, discoverModels, getAvailableModels, resolveModels, cancelSession, createSession, OpencodeUnavailableError } =
  await import('./opencode.js');

function jsonRes(body: unknown, ok = true) {
  const text = JSON.stringify(body);
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => text };
}

function emptyStreamRes() {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return { ok: true, body: stream };
}

const sampleIssue = {
  id: 3,
  owner: 'dachrisch',
  repo: 'widget',
  number: 5,
  title: 'Add feature',
  body: 'Please add it',
  htmlUrl: 'https://github.com/dachrisch/widget/issues/5',
  state: 'developing' as const,
  sessionId: null,
  resultPrUrl: null,
  resultText: null,
};

describe('opencode client', () => {
  it('extracts a PR url from assistant text', () => {
    expect(extractPrUrl('done! https://github.com/dachrisch/widget/pull/12 here')).toBe(
      'https://github.com/dachrisch/widget/pull/12'
    );
    expect(extractPrUrl('CANNOT FULFILL: no tests')).toBeNull();
  });

  it('builds a self-contained develop prompt with repo path and termination rule', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, 'use vitest');
    expect(prompt).toContain('/root/dev/widget');
    expect(prompt).toContain('.worktrees/3');
    expect(prompt).toContain('devhub/issue-5');
    expect(prompt).toContain('Issue #5');
    expect(prompt).toContain('use vitest');
    expect(prompt).toContain('CANNOT FULFILL:');
    expect(prompt).toContain('github.com/dachrisch/widget/pull');
    expect(prompt).toContain('opencode-contribution');
  });

  it('instructs the agent to adopt a leftover worktree instead of failing', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, '');
    expect(prompt).toContain('git worktree add .worktrees/3 -b devhub/issue-5');
    expect(prompt).toContain('if [ -d ".worktrees/3" ]; then');
    expect(prompt).toContain('git checkout devhub/issue-5');
  });

  it('cancelSession aborts then deletes the session, ignoring failures', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      if (opts?.method === 'DELETE') throw new Error('network down');
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });

    await expect(cancelSession('ses_1')).resolves.toBeUndefined();
    const abortCall = fakeFetch.mock.calls.find((c) => String(c[0]).endsWith('/api/session/ses_1/abort'));
    const deleteCall = fakeFetch.mock.calls.find((c) => String(c[0]).endsWith('/api/session/ses_1'));
    expect(abortCall?.[1]?.method).toBe('POST');
    expect(deleteCall?.[1]?.method).toBe('DELETE');
  });

  it('runDevelop cancels a timed-out session before retrying, then succeeds', async () => {
    fakeFetch.mockReset();
    const calls: Array<{ method: string; url: string }> = [];
    let attempts = 0;
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      calls.push({ method: opts?.method ?? 'GET', url: String(url) });
      if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
        attempts++;
        return jsonRes({ data: { id: `ses_${attempts}` } });
      }
      if (String(url).includes('/abort')) return jsonRes({});
      if (opts?.method === 'DELETE') return jsonRes({});
      if (String(url).includes('/prompt')) return jsonRes({ data: { id: 'msg_1' } });
      if (String(url).includes('/event')) return emptyStreamRes();
      if (String(url).includes('/message')) {
        // First two attempts keep working past the tiny poll budget (timeout);
        // the third finishes with a PR.
        if (attempts < 3) {
          return jsonRes({ data: [{ type: 'assistant', content: [{ type: 'text', text: 'still implementing…' }] }] });
        }
        return jsonRes({
          data: [
            {
              type: 'assistant',
              finish: 'stop',
              content: [{ type: 'text', text: 'done -> https://github.com/dachrisch/widget/pull/111' }],
            },
          ],
        });
      }
      return jsonRes({}, false);
    });

    const models = [{ id: 'test-model', providerID: 'opencode' }];
    const text = await runDevelop('do it', () => {}, models, undefined, 50);

    expect(text).toContain('https://github.com/dachrisch/widget/pull/111');
    // Three sessions were created; the first two were abandoned and cancelled.
    expect(attempts).toBe(3);
    const aborts = calls.filter((c) => c.url.endsWith('/abort'));
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(aborts.map((c) => c.url)).toEqual([
      'https://code.lehel.xyz/api/session/ses_1/abort',
      'https://code.lehel.xyz/api/session/ses_2/abort',
    ]);
    expect(deletes.map((c) => c.url)).toEqual([
      'https://code.lehel.xyz/api/session/ses_1',
      'https://code.lehel.xyz/api/session/ses_2',
    ]);
  }, 20_000);

  it('pins known-good model tiers including DeepSeek V4 Flash', () => {
    expect(defaultModels()[0]).toEqual({ id: 'mimo-v2.5-free', providerID: 'opencode' });
    expect(defaultModels()).toContainEqual({ id: 'deepseek-v4-flash', providerID: 'opencode' });
  });

  it('discoverModels returns every listed model (free and paid) from the models endpoint', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/model')) {
        return jsonRes([
          { id: 'mimo-v2.5-free', providerID: 'opencode' },
          { id: 'gpt-5', providerID: 'opencode' },
          { id: 'deepseek-v4-flash', providerID: 'opencode' },
          { id: 'mimo-v2.5-free', providerID: 'opencode' },
          { id: 'nemotron-3.5-lightning-free', providerID: 'opencode' },
        ]);
      }
      return jsonRes({}, false);
    });
    const models = await discoverModels();
    expect(models).toEqual([
      { id: 'mimo-v2.5-free', providerID: 'opencode' },
      { id: 'gpt-5', providerID: 'opencode' },
      { id: 'deepseek-v4-flash', providerID: 'opencode' },
      { id: 'mimo-v2.5-free', providerID: 'opencode' },
      { id: 'nemotron-3.5-lightning-free', providerID: 'opencode' },
    ]);
  });

  it('discoverModels resolves null when the listing endpoints are unavailable', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async () => jsonRes({}, false));
    expect(await discoverModels()).toBeNull();
  });

  it('getAvailableModels returns the pinned tiers when discovery fails with no good list', async () => {
    vi.resetModules();
    const fresh = (await import('./opencode.js')) as typeof import('./opencode.js');
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async () => jsonRes({}, false));
    expect(await fresh.getAvailableModels()).toEqual(fresh.defaultModels());
  });

  it('getAvailableModels keeps serving the last good list during discovery failure and re-probes after the failure window', async () => {
    vi.resetModules();
    const fresh = (await import('./opencode.js')) as typeof import('./opencode.js');
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/model')) {
        return jsonRes({ data: [{ id: 'good-model', providerID: 'opencode' }] });
      }
      return jsonRes({}, false);
    });
    const good = await fresh.getAvailableModels();
    expect(good).toEqual([{ id: 'good-model', providerID: 'opencode' }]);

    vi.useFakeTimers();
    try {
      // Age the good list past the full TTL so the next call must probe.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      fakeFetch.mockReset();
      fakeFetch.mockImplementation(async () => jsonRes({}, false));
      const during = await fresh.getAvailableModels();
      // A stale *real* list beats the pinned tiers, and the failure is not
      // cached as truth for the full TTL.
      expect(during).toEqual([{ id: 'good-model', providerID: 'opencode' }]);
      const fetchesDuringFailure = fakeFetch.mock.calls.length;

      vi.advanceTimersByTime(1000);
      await fresh.getAvailableModels();
      expect(fakeFetch.mock.calls.length).toBe(fetchesDuringFailure);

      // Past the failure window the probe is attempted again.
      vi.advanceTimersByTime(30 * 1000);
      await fresh.getAvailableModels();
      expect(fakeFetch.mock.calls.length).toBeGreaterThan(fetchesDuringFailure);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getAvailableModels dedupes discovered models and serves them from cache', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/model')) {
        return jsonRes({
          data: [
            { id: 'a-free', providerID: 'opencode' },
            { id: 'b-free', providerID: 'opencode' },
            { id: 'a-free', providerID: 'opencode' },
            { id: 'deepseek-v4-flash', providerID: 'opencode' },
            { id: 'paid-tier', providerID: 'opencode' },
          ],
        });
      }
      return jsonRes({}, false);
    });
    const models = await getAvailableModels();
    expect(models).toEqual([
      { id: 'a-free', providerID: 'opencode' },
      { id: 'b-free', providerID: 'opencode' },
      { id: 'deepseek-v4-flash', providerID: 'opencode' },
      { id: 'paid-tier', providerID: 'opencode' },
    ]);
    const fetchCount = fakeFetch.mock.calls.length;
    await getAvailableModels();
    expect(fakeFetch.mock.calls.length).toBe(fetchCount);
  });

  it('resolveModels heads the list with the selected model and keeps tiers as failover', () => {
    const picked = resolveModels({ id: 'laguna-s-2.1-free', providerID: 'opencode' });
    expect(picked[0]).toEqual({ id: 'laguna-s-2.1-free', providerID: 'opencode' });
    expect(picked).toHaveLength(defaultModels().length);
    expect(picked).toContainEqual({ id: 'mimo-v2.5-free', providerID: 'opencode' });
    expect(resolveModels(null)).toEqual(defaultModels());
    expect(resolveModels(undefined)).toEqual(defaultModels());
  });

  it('runDevelop creates a session, sends the prompt, and returns the final text', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
        return jsonRes({ data: { id: 'ses_1' } });
      }
      if (String(url).includes('/prompt')) {
        return jsonRes({ data: { id: 'msg_1' } });
      }
      if (String(url).includes('/event')) {
        return emptyStreamRes();
      }
      if (String(url).includes('/message')) {
        return jsonRes({
          data: [
            {
              type: 'assistant',
              finish: 'stop',
              content: [{ type: 'text', text: 'implemented -> https://github.com/dachrisch/widget/pull/99' }],
            },
          ],
        });
      }
      return jsonRes({}, false);
    });

    const events: unknown[] = [];
    const text = await runDevelop('do it', (e) => events.push(e));

    expect(text).toContain('https://github.com/dachrisch/widget/pull/99');
    const createCall = fakeFetch.mock.calls.find((c) => String(c[0]).endsWith('/api/session'));
    const promptCall = fakeFetch.mock.calls.find((c) => String(c[0]).includes('/prompt'));
    expect(createCall).toBeTruthy();
    expect(promptCall?.[1]?.body).toContain('do it');
  });

  it('runDevelop fails over to the next model tier on repeated session-create failure', async () => {
    fakeFetch.mockReset();
    let createAttempts = 0;
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
        createAttempts++;
        // First model (mimo) always fails; second model (deepseek-v4-flash) succeeds.
        if (createAttempts <= 3) {
          return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
        }
        return jsonRes({ data: { id: 'ses_2' } });
      }
      if (String(url).includes('/prompt')) return jsonRes({ data: { id: 'msg_2' } });
      if (String(url).includes('/event')) return emptyStreamRes();
      if (String(url).includes('/message')) {
        return jsonRes({
          data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'CANNOT FULFILL: no repo' }] }],
        });
      }
      return jsonRes({}, false);
    });

    const text = await runDevelop('x', () => {});
    expect(text).toContain('CANNOT FULFILL');
    // 3 attempts on model 1 (all failed) + 1 attempt on model 2 = 4 session creates.
    expect(createAttempts).toBe(4);
  }, 30_000);

  it('createSession tags edge 404 page-not-found as server unavailability, not an API error', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '404 page not found\n',
    }));
    await expect(createSession(defaultModels()[0])).rejects.toThrowError(OpencodeUnavailableError);
    await expect(createSession(defaultModels()[0])).rejects.toThrow(/opencode server unavailable: 404/);
  });

  it('createSession keeps plain API 404s as ordinary errors', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '{"_tag":"NotFoundError"}',
    }));
    await expect(createSession(defaultModels()[0])).rejects.toThrow(/^opencode session create failed: 404/);
  });

  it('runDevelop rides out a mid-run edge 404 (server restart) and recovers', async () => {
    fakeFetch.mockReset();
    let polls = 0;
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
        return jsonRes({ data: { id: 'ses_1' } });
      }
      if (String(url).includes('/abort') || (opts?.method === 'DELETE' && String(url).includes('/session/'))) {
        return jsonRes({});
      }
      if (String(url).includes('/prompt')) return jsonRes({ data: { id: 'msg_1' } });
      if (String(url).includes('/event')) return emptyStreamRes();
      if (String(url).includes('/message')) {
        // First poll hits the watchtower restart window at the edge; the next
        // one finds the run finished.
        polls++;
        if (polls === 1) {
          return { ok: false, status: 404, json: async () => ({}), text: async () => '404 page not found' };
        }
        return jsonRes({
          data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'recovered -> https://github.com/dachrisch/widget/pull/7' }] }],
        });
      }
      return jsonRes({}, false);
    });

    const text = await runDevelop('x', () => {}, [{ id: 'test-model', providerID: 'opencode' }]);
    expect(text).toContain('https://github.com/dachrisch/widget/pull/7');
    expect(polls).toBe(2);
  }, 20_000);

  it('runDevelop surfaces server unavailability clearly when the outage persists', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => '404 page not found' };
      }
      if (String(url).includes('/abort')) return jsonRes({});
      if (opts?.method === 'DELETE') return jsonRes({});
      return jsonRes({}, false);
    });

    await expect(runDevelop('x', () => {}, [{ id: 'test-model', providerID: 'opencode' }])).rejects.toThrow(
      /opencode server unavailable: 404: 404 page not found/
    );
  }, 30_000);
});
