import { describe, expect, it, vi } from 'vitest';

const fakeFetch = vi.fn();

vi.mock('undici', () => {
  class Agent {}
  return {
    Agent,
    fetch: (...args: unknown[]) => fakeFetch(...args),
  };
});

const { runDevelop, extractPrUrl, extractBaseSha, buildDevelopPrompt, buildVerifyPrompt, parseVerifyResult, repoPathFor, ensureWorktree, defaultModels, discoverModels, getAvailableModels, resolveModels, sanitizeModels, cancelSession, createSession, OpencodeUnavailableError } =
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

  const sampleWorktree = {
    directory: '/root/.local/share/opencode/worktree/h1/3-service',
    branch: 'opencode/3-service',
  };

  it('builds a self-contained develop prompt rooted at the provisioned worktree', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, 'use vitest', sampleWorktree);
    expect(prompt).toContain(sampleWorktree.directory);
    expect(prompt).toContain(sampleWorktree.branch);
    expect(prompt).toContain('Issue #5');
    expect(prompt).toContain('use vitest');
    expect(prompt).toContain('CANNOT FULFILL:');
    expect(prompt).toContain('github.com/dachrisch/widget/pull');
    expect(prompt).toContain('opencode-contribution');
  });

  it('requires the Fixes trailer as the last PR body line with a self-check', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, '', sampleWorktree);
    // The trailer must survive a full-length PR description (dontforget#189:
    // PR #190 shipped a rich body but dropped the keyword, so the issue never
    // auto-closed).
    expect(prompt).toContain('Fixes #5');
    expect(prompt).toContain('LAST line');
    expect(prompt).toContain('gh pr view');
    expect(prompt).toContain('gh pr edit');
  });

  it('requires the agent to normalize the base branch before implementing', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, '', sampleWorktree);
    // Wrong-base branches (devhub#223 → PR #225 shipped 3 foreign commits)
    // must never happen again: step 0a pins the branch to origin/master and
    // the final message carries the base SHA for DevHub to record.
    expect(prompt).toContain('origin/master');
    expect(prompt).toContain('git fetch origin');
    expect(prompt).toContain('git checkout -B');
    expect(prompt).toContain('BASE_SHA');
    expect(prompt).toContain('--force-with-lease');
  });

  it('extractBaseSha parses the handshake line and rejects garbage', () => {
    const sha = 'a'.repeat(40);
    expect(extractBaseSha(`BASE_SHA: ${sha}\ndone https://github.com/dachrisch/widget/pull/12`)).toBe(sha);
    expect(extractBaseSha('done, no handshake here')).toBeNull();
    expect(extractBaseSha('BASE_SHA: xyz')).toBeNull();
    expect(extractBaseSha('BASE_SHA: ' + 'g'.repeat(40))).toBeNull();
  });

  it('builds a read-only verifier prompt with numbered criteria and PRs', () => {
    const prompt = buildVerifyPrompt(sampleIssue as never, ['pill renders everywhere', 'build stays green'], [
      'https://github.com/dachrisch/widget/pull/12',
    ]);
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('1. pill renders everywhere');
    expect(prompt).toContain('2. build stays green');
    expect(prompt).toContain('https://github.com/dachrisch/widget/pull/12');
    expect(prompt).toContain('gh pr diff');
    expect(prompt).toContain('"verdicts"');
    expect(prompt).not.toContain('git push');
  });

  it('parseVerifyResult passes only when every criterion has a passing verdict', () => {
    const ok = parseVerifyResult(
      '{"verdicts": [{"ac": 1, "pass": true, "evidence": "a.ts:1"}, {"ac": 2, "pass": true, "evidence": "b.ts:2"}]}',
      2
    );
    expect(ok).toMatchObject({ allPass: true, inconclusive: false });
    expect(ok.verdicts).toHaveLength(2);
  });

  it('parseVerifyResult fails missing verdicts and reports garbage as inconclusive', () => {
    const missing = parseVerifyResult('{"verdicts": [{"ac": 2, "pass": true, "evidence": "b"}]}', 2);
    expect(missing.allPass).toBe(false);
    expect(missing.inconclusive).toBe(false);
    expect(missing.verdicts.find((v) => v.ac === 1)).toMatchObject({ pass: false });

    for (const bad of ['no json here', '{oops', '{"verdicts": "nah"}']) {
      const r = parseVerifyResult(bad, 1);
      expect(r.allPass).toBe(false);
      expect(r.inconclusive).toBe(true);
    }
  });

  it('does not ask the agent to create or adopt a worktree itself', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, '', sampleWorktree);
    expect(prompt).not.toContain('git worktree add');
    expect(prompt).not.toContain('adopt it in place');
  });

  it('tells the agent to remove the provisioned worktree by its real path as the last step', () => {
    const prompt = buildDevelopPrompt(sampleIssue as never, '', sampleWorktree);
    expect(prompt).toContain(`git worktree remove ${sampleWorktree.directory}`);
  });

  it('builds a per-run prompt with the run repo (owner-qualified checkout root) and carry-over', () => {
    const runWorktree = {
      directory: '/root/.local/share/opencode/worktree/h2/3-infra',
      branch: 'opencode/3-infra',
    };
    const prompt = buildDevelopPrompt(
      sampleIssue as never,
      '',
      runWorktree,
      { role: 'infra', repoOwner: 'dachrisch', repoName: 'infra', projectId: 7 },
      { prUrl: 'https://github.com/dachrisch/widget/pull/11', summary: 'service PR' }
    );
    expect(prompt).toContain(runWorktree.directory);
    expect(prompt).toContain(runWorktree.branch);
    expect(prompt).toContain('/root/dev/dachrisch/infra');
    expect(prompt).toContain('https://github.com/dachrisch/widget/pull/11');
    expect(prompt).toContain('Run role: infra');
  });

  it('renders the idea-context section when ideaContext is passed, omits it otherwise', () => {
    const ideaContext = {
      summary: 'Add OAuth login with refresh tokens.',
      considered: [
        { title: 'Session cookies', desc: 'Simple', tradeoff: 'Harder to scale', chosen: false },
        { title: 'OAuth + refresh tokens', desc: 'Industry standard', chosen: true },
      ],
    };
    const withContext = buildDevelopPrompt(sampleIssue as never, '', sampleWorktree, undefined, undefined, ideaContext);
    expect(withContext).toContain('## Why this idea was shaped this way');
    expect(withContext).toContain('Add OAuth login with refresh tokens.');
    expect(withContext).toContain('[CHOSEN] OAuth + refresh tokens: Industry standard');
    expect(withContext).toContain('Session cookies: Simple (tradeoff: Harder to scale)');

    const withoutContext = buildDevelopPrompt(sampleIssue as never, '', sampleWorktree);
    expect(withoutContext).not.toContain('## Why this idea was shaped this way');
  });

  it('resolves the provisioned checkout root for a repo owner/name', () => {
    expect(repoPathFor('dachrisch', 'widget')).toBe('/root/dev/dachrisch/widget');
  });

  it('ensureWorktree reuses an existing worktree whose directory ends with the given name', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      expect(opts?.method ?? 'GET').toBe('GET');
      expect(String(url)).toBe(
        `https://code.lehel.xyz/experimental/worktree?directory=${encodeURIComponent('/root/dev/dachrisch/widget')}`
      );
      return jsonRes(['/root/.local/share/opencode/worktree/abc/3-service']);
    });

    const result = await ensureWorktree('dachrisch', 'widget', '3-service');
    expect(result).toEqual({
      directory: '/root/.local/share/opencode/worktree/abc/3-service',
      branch: 'opencode/3-service',
    });
  });

  it('ensureWorktree creates a new worktree when none matches the name', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string, opts?: { method?: string; body?: string }) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET') {
        return jsonRes(['/root/.local/share/opencode/worktree/abc/other-run']);
      }
      expect(method).toBe('POST');
      expect(JSON.parse(String(opts?.body))).toEqual({ name: '3-service' });
      return jsonRes({
        name: '3-service',
        branch: 'opencode/3-service',
        directory: '/root/.local/share/opencode/worktree/xyz/3-service',
      });
    });

    const result = await ensureWorktree('dachrisch', 'widget', '3-service');
    expect(result).toEqual({
      directory: '/root/.local/share/opencode/worktree/xyz/3-service',
      branch: 'opencode/3-service',
    });
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

  it('pins known-good model tiers that the server can still serve', () => {
    expect(defaultModels()[0]).toEqual({ id: 'mimo-v2.5-free', providerID: 'opencode' });
    // deepseek-v4-flash moved to the opencode-go provider; pinning it under
    // `opencode` made every run fail server-side after prompt admission.
    expect(defaultModels()).not.toContainEqual({ id: 'deepseek-v4-flash', providerID: 'opencode' });
    expect(defaultModels()).toContainEqual({ id: 'big-pickle', providerID: 'opencode' });
  });

  it('sanitizeModels drops models the registry no longer offers, keeping order', () => {
    const available = [
      { id: 'mimo-v2.5-free', providerID: 'opencode' },
      { id: 'deepseek-v4-flash', providerID: 'opencode-go', status: 'active', enabled: true },
      { id: 'old-free', providerID: 'opencode', status: 'deprecated', enabled: true },
      { id: 'disabled', providerID: 'opencode', status: 'active', enabled: false },
    ];
    const chain = [
      { id: 'deepseek-v4-flash', providerID: 'opencode' },
      { id: 'old-free', providerID: 'opencode' },
      { id: 'disabled', providerID: 'opencode' },
      { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      { id: 'mimo-v2.5-free', providerID: 'opencode' },
    ];
    expect(sanitizeModels(chain, available)).toEqual([
      { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      { id: 'mimo-v2.5-free', providerID: 'opencode' },
    ]);
  });

  it('sanitizeModels falls back to the original chain when nothing is usable', () => {
    const chain = [{ id: 'x', providerID: 'opencode' }];
    expect(sanitizeModels(chain, [])).toEqual(chain);
    expect(sanitizeModels(chain, [{ id: 'y', providerID: 'opencode', status: 'deprecated' }])).toEqual(chain);
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
    // Selected model heads the chain; the tiers follow unchanged behind it.
    expect(picked).toHaveLength(defaultModels().length + 1);
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
        // First tier (mimo) always fails; the next tier succeeds.
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

  it('createSession sends location.directory in the request body when a directory is given', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async () => jsonRes({ data: { id: 'ses_1' } }));

    await createSession(defaultModels()[0], '/root/dev/widget');

    const body = JSON.parse(fakeFetch.mock.calls[0][1].body as string);
    expect(body.location).toEqual({ directory: '/root/dev/widget' });
  });

  it('createSession omits location from the request body when no directory is given', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async () => jsonRes({ data: { id: 'ses_1' } }));

    await createSession(defaultModels()[0]);

    const body = JSON.parse(fakeFetch.mock.calls[0][1].body as string);
    expect(body.location).toBeUndefined();
  });

  it('runDevelop forwards its directory argument to createSession as location.directory', async () => {
    fakeFetch.mockReset();
    fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
      if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
        return jsonRes({ data: { id: 'ses_1' } });
      }
      if (String(url).includes('/prompt')) return jsonRes({ data: { id: 'msg_1' } });
      if (String(url).includes('/event')) return emptyStreamRes();
      if (String(url).includes('/message')) {
        return jsonRes({
          data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'done' }] }],
        });
      }
      return jsonRes({}, false);
    });

    await runDevelop('x', () => {}, [{ id: 'test-model', providerID: 'opencode' }], undefined, undefined, '/root/dev/widget');

    const createCall = fakeFetch.mock.calls.find((c) => String(c[0]).endsWith('/api/session'));
    const body = JSON.parse(createCall?.[1]?.body as string);
    expect(body.location).toEqual({ directory: '/root/dev/widget' });
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
