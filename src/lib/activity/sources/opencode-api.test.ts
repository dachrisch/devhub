import { describe, expect, it } from 'vitest';
import { OpencodeUnavailableError } from '../../opencode';
import {
  deriveStatus,
  listSessions,
  normalizeSession,
  subscribeEvents,
  type OpencodeFetch,
  type OpencodeResponse,
} from './opencode-api';

function res(status: number, body: string): OpencodeResponse {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

describe('deriveStatus', () => {
  it('is working when recently updated, idle otherwise', () => {
    const now = 1_000_000;
    expect(deriveStatus(now - 1000, now)).toBe('working');
    expect(deriveStatus(now - 10 * 60 * 1000, now)).toBe('idle');
    expect(deriveStatus(null, now)).toBe('idle');
  });
});

describe('normalizeSession', () => {
  it('maps server fields into a normalized activity session', () => {
    const s = normalizeSession(
      {
        id: 'ses_1',
        projectID: 'proj',
        agent: 'build',
        model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
        cost: 0.05,
        tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 7, write: 1 } },
        time: { created: 1000, updated: 2000 },
        location: { directory: '/root/dev/x' },
      },
      2000
    );
    expect(s.source).toBe('opencode-web');
    expect(s.sessionId).toBe('ses_1');
    expect(s.harness).toBe('opencode');
    expect(s.model).toBe('opencode-go/deepseek-v4.1-flash');
    expect(s.project).toBe('/root/dev/x');
    expect(s.tokens).toEqual({ input: 10, output: 2, reasoning: 3, cacheRead: 7, cacheWrite: 1 });
    expect(s.costKind).toBe('reported');
    expect(s.status).toBe('working');
  });
});

describe('listSessions', () => {
  it('paginates via the cursor and concatenates pages', async () => {
    const calls: string[] = [];
    const fetchFn: OpencodeFetch = async (url) => {
      calls.push(url);
      if (!url.includes('cursor=')) {
        return res(200, JSON.stringify({ data: [{ id: 's1' }], cursor: { next: 'CUR/1+' } }));
      }
      return res(200, JSON.stringify({ data: [{ id: 's2' }], cursor: { next: null } }));
    };
    const out = await listSessions({ fetchFn, now: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`cursor=${encodeURIComponent('CUR/1+')}`);
    expect(out.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('stops at maxPages', async () => {
    let n = 0;
    const fetchFn: OpencodeFetch = async () => {
      n += 1;
      return res(200, JSON.stringify({ data: [{ id: `s${n}` }], cursor: { next: 'more' } }));
    };
    const out = await listSessions({ fetchFn, maxPages: 3, now: 1 });
    expect(out).toHaveLength(3);
  });

  it('treats an SPA HTML body (unknown route) as not-found', async () => {
    const fetchFn: OpencodeFetch = async () => res(200, '<!doctype html><html><body>spa</body></html>');
    expect(await listSessions({ fetchFn })).toEqual([]);
  });

  it('throws OpencodeUnavailableError on 5xx', async () => {
    const fetchFn: OpencodeFetch = async () => res(503, 'restarting');
    await expect(listSessions({ fetchFn })).rejects.toBeInstanceOf(OpencodeUnavailableError);
  });
});

describe('subscribeEvents', () => {
  it('forwards parsed events and skips the server.connected handshake', async () => {
    const enc = new TextEncoder();
    const chunk =
      'data: {"id":"e0","type":"server.connected","properties":{}}\n\n' +
      'data: {"id":"e1","type":"message.updated","properties":{"x":1}}\n\n';
    let sent = false;
    const body = {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: enc.encode(chunk) };
        },
      }),
    };
    const fetchFn: OpencodeFetch = async () => ({ status: 200, ok: true, text: async () => '', body });
    const seen: { type?: string }[] = [];
    await subscribeEvents((e) => seen.push(e), undefined, fetchFn);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('message.updated');
  });
});
