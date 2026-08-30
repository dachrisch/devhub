import { randomBytes } from 'node:crypto';
import { ENV } from './env';
import { createAuthSession, deleteAuthSession, getAuthSession, type AuthSession } from './store';
import { isAllowedMember } from './github';

export const SESSION_COOKIE = 'devhub_session';
export const STATE_COOKIE = 'devhub_oauth_state';
const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  login: string;
  avatarUrl: string | null;
}

export interface SessionUser extends AuthUser {
  id: string;
  token: string;
}

// SQLite datetime('now') format, UTC.
function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export function sessionCookie(name: string, value: string, opts: { maxAgeSeconds: number; httpOnly: boolean }): string {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${opts.maxAgeSeconds}`,
    'SameSite=Lax',
    opts.httpOnly ? 'HttpOnly' : '',
    secure ? 'Secure' : '',
  ].filter(Boolean);
  return parts.join('; ');
}

export function sessionClearCookie(name: string): string {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax', secure ? 'Secure' : ''].filter(Boolean);
  return parts.join('; ');
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// OAuth login: build the GitHub authorize URL and stash a CSRF state nonce in a
// short-lived httpOnly cookie so the callback can verify it.
export function buildLoginUrl(): { url: string; state: string; stateCookie: string } {
  const state = randomBytes(16).toString('hex');
  const url =
    `https://github.com/login/oauth/authorize` +
    `?client_id=${encodeURIComponent(ENV.githubClientId)}` +
    `&redirect_uri=${encodeURIComponent(ENV.githubRedirectUri)}` +
    `&scope=repo%20read:org` +
    `&state=${state}`;
  const stateCookie = sessionCookie(STATE_COOKIE, state, { maxAgeSeconds: 600, httpOnly: true });
  return { url, state, stateCookie };
}

interface GithubTokenResponse {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: ENV.githubClientId,
      client_secret: ENV.githubClientSecret,
      code,
      redirect_uri: ENV.githubRedirectUri,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed (${res.status})`);
  const data = (await res.json()) as GithubTokenResponse;
  if (!data.access_token) {
    throw new Error(`GitHub token exchange error: ${data.error_description ?? data.error ?? 'no token'}`);
  }
  console.log('[exchangeCode] granted scopes:', data.scope);
  return data.access_token;
}

interface GithubUser {
  login: string;
  avatar_url?: string;
}

// Fetches the authenticated user (login + avatar). Called with the fresh token
// from the callback, and per-request from the session.
export async function fetchUser(token: string): Promise<AuthUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub user fetch failed (${res.status})`);
  const data = (await res.json()) as GithubUser;
  return { login: data.login, avatarUrl: data.avatar_url ?? null };
}

// Creates a DB-backed session and returns the session cookie (Set-Cookie value).
export function createSession(token: string, user: AuthUser): { id: string; cookie: string } {
  const id = randomBytes(24).toString('hex');
  const now = sqliteNow();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  createAuthSession({ id, token, login: user.login, avatarUrl: user.avatarUrl, createdAt: now, expiresAt: expires });
  return { id, cookie: sessionCookie(SESSION_COOKIE, id, { maxAgeSeconds: SESSION_TTL_DAYS * 86400, httpOnly: true }) };
}

// Returns the session user (incl. token) for a request, or null when no valid
// session cookie exists. Does NOT re-check org membership (that's the refresh
// route's job, to keep GETs cheap).
export function getSession(req: Request): SessionUser | null {
  const id = readCookie(req, SESSION_COOKIE);
  if (!id) return null;
  const session = getAuthSession(id);
  if (!session) return null;
  return { id: session.id, login: session.login, avatarUrl: session.avatarUrl, token: session.token };
}

// Deletes the session row for the request's cookie; returns the cookie to clear.
export function destroySession(req: Request): string | null {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) deleteAuthSession(id);
  return sessionClearCookie(SESSION_COOKIE);
}

export function verifyState(req: Request): boolean {
  const received = new URL(req.url).searchParams.get('state');
  if (!received) return false;
  const expected = readCookie(req, STATE_COOKIE);
  return Boolean(expected && received === expected);
}

// Re-checks org membership with the session token (used on refresh so revoked
// membership takes effect promptly). Throws on non-member / GitHub error.
export async function requireMember(req: Request): Promise<SessionUser> {
  const session = getSession(req);
  if (!session) throw new UnauthorizedError('not signed in');
  if (!(await isAllowedMember(session.token))) {
    deleteAuthSession(session.id);
    throw new ForbiddenError('not a member');
  }
  return session;
}

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export type { AuthSession };