import { describe, expect, it, vi } from 'vitest';

const fakeFetch = vi.fn();

vi.mock('undici', () => {
  class Agent {}
  return {
    Agent,
    fetch: (...args: unknown[]) => fakeFetch(...args),
  };
});

const { runDevelop, extractPrUrl, buildDevelopPrompt, defaultModels } = await import('./opencode.js');

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body };
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
    expect(prompt).toContain('/home/cda/dev/dachrisch/widget');
    expect(prompt).toContain('Issue #5');
    expect(prompt).toContain('use vitest');
    expect(prompt).toContain('CANNOT FULFILL:');
    expect(prompt).toContain('github.com/dachrisch/widget/pull');
  });

  it('pins known-good free model tiers', () => {
    expect(defaultModels()[0]).toEqual({ id: 'mimo-v2.5-free', providerID: 'opencode' });
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
        // First model (mimo) always fails; second model (big-pickle) succeeds.
        if (createAttempts <= 3) {
          return { ok: false, status: 503, json: async () => ({}) };
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
  });
});
