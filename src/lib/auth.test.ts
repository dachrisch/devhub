import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-auth-test-${process.pid}.db`);

vi.mock('./github.js', () => ({
  isAllowedMember: vi.fn(),
}));

const { createAuthSession, getAuthSession, deleteAuthSession } = await import('./store.js');
const { requireMember, GithubUnavailableError, ForbiddenError, UnauthorizedError } = await import('./auth.js');
const { isAllowedMember } = await import('./github.js');

afterEach(() => {
  vi.mocked(isAllowedMember).mockReset();
  vi.unstubAllGlobals();
});

function seedSession(id: string, token: string, refreshToken: string | null, tokenExpiresAt: string | null): void {
  createAuthSession({
    id,
    token,
    login: 'dachrisch',
    avatarUrl: null,
    createdAt: '2026-08-30 00:00:00',
    expiresAt: '2099-01-01 00:00:00',
    refreshToken,
    tokenExpiresAt,
  });
}

function reqFor(id: string): Request {
  return new Request('http://localhost/api/issues', { headers: { cookie: `devhub_session=${id}` } });
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterAll(() => {
  for (const f of [process.env.DEVHUB_DB!, `${process.env.DEVHUB_DB}-wal`, `${process.env.DEVHUB_DB}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('auth sessions', () => {
  it('creates and reads back a session', () => {
    createAuthSession({
      id: 's1',
      token: 'tok-123',
      login: 'dachrisch',
      avatarUrl: 'https://avatars.example/u',
      createdAt: '2026-08-30 00:00:00',
      expiresAt: '2099-01-01 00:00:00',
      refreshToken: null,
      tokenExpiresAt: null,
    });
    const session = getAuthSession('s1');
    expect(session?.login).toBe('dachrisch');
    expect(session?.token).toBe('tok-123');
    expect(session?.avatarUrl).toBe('https://avatars.example/u');
  });

  it('returns null for an unknown id', () => {
    expect(getAuthSession('nope')).toBeNull();
  });

  it('deletes a session', () => {
    createAuthSession({
      id: 's2',
      token: 'tok-2',
      login: 'x',
      avatarUrl: null,
      createdAt: '2026-08-30 00:00:00',
      expiresAt: '2099-01-01 00:00:00',
      refreshToken: null,
      tokenExpiresAt: null,
    });
    deleteAuthSession('s2');
    expect(getAuthSession('s2')).toBeNull();
  });

  it('treats an expired session as gone', () => {
    createAuthSession({
      id: 's3',
      token: 'tok-3',
      login: 'x',
      avatarUrl: null,
      createdAt: '2020-01-01 00:00:00',
      expiresAt: '2020-01-02 00:00:00',
      refreshToken: null,
      tokenExpiresAt: null,
    });
    expect(getAuthSession('s3')).toBeNull();
  });
});

describe('requireMember', () => {
  it('throws GithubUnavailableError when the GitHub org check fails', async () => {
    createAuthSession({
      id: 's-gh-fail',
      token: 'tok-gh-fail',
      login: 'dachrisch',
      avatarUrl: null,
      createdAt: '2026-08-30 00:00:00',
      expiresAt: '2099-01-01 00:00:00',
      refreshToken: null,
      tokenExpiresAt: null,
    });
    vi.mocked(isAllowedMember).mockRejectedValueOnce(
      new Error('GitHub request failed (500): https://api.github.com/user/orgs')
    );
    const req = new Request('http://localhost/api/issues', {
      headers: { cookie: 'devhub_session=s-gh-fail' },
    });
    await expect(requireMember(req)).rejects.toBeInstanceOf(GithubUnavailableError);
  });

  it('throws ForbiddenError when the user is not a member', async () => {
    createAuthSession({
      id: 's-outsider',
      token: 'tok-outsider',
      login: 'outsider',
      avatarUrl: null,
      createdAt: '2026-08-30 00:00:00',
      expiresAt: '2099-01-01 00:00:00',
      refreshToken: null,
      tokenExpiresAt: null,
    });
    vi.mocked(isAllowedMember).mockResolvedValueOnce(false);
    const req = new Request('http://localhost/api/issues', {
      headers: { cookie: 'devhub_session=s-outsider' },
    });
    await expect(requireMember(req)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('requireMember token rotation (devhub OAuth refresh)', () => {
  it('shares one refresh across concurrent requests (GitHub rotates the token)', async () => {
    seedSession('s-refresh', 'old-token', 'old-refresh', '2020-01-01 00:00:00');
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (!String(url).includes('access_token')) throw new Error(`unexpected fetch ${String(url)}`);
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return tokenResponse({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 28800, scope: 'repo read:org' });
      })
    );
    vi.mocked(isAllowedMember).mockResolvedValue(true);

    const sessions = await Promise.all(Array.from({ length: 5 }, () => requireMember(reqFor('s-refresh'))));

    expect(refreshCalls).toBe(1);
    expect(sessions.every((s) => s.token === 'new-token')).toBe(true);
    expect(sessions.every((s) => s.refreshToken === 'new-refresh')).toBe(true);
    const row = getAuthSession('s-refresh');
    expect(row?.token).toBe('new-token');
    expect(row?.refreshToken).toBe('new-refresh');
  });

  it('clears a dead refresh token and keeps serving the access token', async () => {
    seedSession('s-dead-refresh', 'still-good', 'dead-refresh', '2020-01-01 00:00:00');
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        refreshCalls++;
        return tokenResponse({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
      })
    );
    vi.mocked(isAllowedMember).mockResolvedValue(true);

    const first = await requireMember(reqFor('s-dead-refresh'));
    expect(first.token).toBe('still-good');
    let row = getAuthSession('s-dead-refresh');
    expect(row?.refreshToken).toBeNull();
    expect(row?.tokenExpiresAt).toBeNull();

    // No refresh token left: subsequent requests never hit the token endpoint again.
    await requireMember(reqFor('s-dead-refresh'));
    expect(refreshCalls).toBe(1);
    row = getAuthSession('s-dead-refresh');
    expect(row?.refreshToken).toBeNull();
  });

  it('drops the session on a 401 with no refresh token', async () => {
    seedSession('s-401', 'expired', null, null);
    vi.mocked(isAllowedMember).mockRejectedValueOnce(
      new Error('GitHub request failed (401): https://api.github.com/user/orgs')
    );

    await expect(requireMember(reqFor('s-401'))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(getAuthSession('s-401')).toBeNull();
  });
});