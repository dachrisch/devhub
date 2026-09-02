import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEVHUB_DB = path.join(os.tmpdir(), `devhub-auth-test-${process.pid}.db`);

vi.mock('./github.js', () => ({
  isAllowedMember: vi.fn(),
}));

const { createAuthSession, getAuthSession, deleteAuthSession } = await import('./store.js');
const { requireMember, GithubUnavailableError, ForbiddenError } = await import('./auth.js');
const { isAllowedMember } = await import('./github.js');

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