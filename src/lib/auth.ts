import { randomBytes } from 'node:crypto';
import { ENV } from './env';
import { createAuthSession, deleteAuthSession, getAuthSession, updateSessionToken, type AuthSession } from './store';
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
  refreshToken: string | null;
  tokenExpiresAt: string | null;
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
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface ExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

export async function exchangeCode(code: string): Promise<ExchangeResult> {
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
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? null,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<ExchangeResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: ENV.githubClientId,
      client_secret: ENV.githubClientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token refresh failed (${res.status})`);
  const data = (await res.json()) as GithubTokenResponse;
  if (!data.access_token) {
    throw new Error(
      `GitHub token refresh error${data.error ? ` (${data.error})` : ''}: ${data.error_description ?? data.error ?? 'no token'}`
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: data.expires_in ?? null,
  };
}

function toSessionUser(session: AuthSession): SessionUser {
  return {
    id: session.id, login: session.login, avatarUrl: session.avatarUrl,
    token: session.token, refreshToken: session.refreshToken, tokenExpiresAt: session.tokenExpiresAt,
  };
}

// True when the access token is at/near expiry and a refresh token is available.
function needsRefresh(session: SessionUser, withinMs = 5 * 60_000): boolean {
  if (!session.refreshToken || !session.tokenExpiresAt) return false;
  return new Date(session.tokenExpiresAt + 'Z').getTime() - Date.now() < withinMs;
}

function tokenExpiryFrom(expiresIn: number | null): string | null {
  return expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
}

// GitHub rotates (invalidates) the refresh token on every use, so concurrent
// requests for the same session must share a single refresh instead of racing
// with the same single-use token — that race is what poisons the stored token.
const inflightRefresh = new Map<string, Promise<SessionUser | null>>();

function refreshSessionSingleFlight(session: SessionUser): Promise<SessionUser | null> {
  const existing = inflightRefresh.get(session.id);
  if (existing) return existing;
  const pending = performRefresh(session).finally(() => inflightRefresh.delete(session.id));
  inflightRefresh.set(session.id, pending);
  return pending;
}

async function performRefresh(session: SessionUser): Promise<SessionUser | null> {
  // Re-read first: a concurrent request may already have rotated the token.
  const latest = getAuthSession(session.id);
  if (!latest) return null;
  if (!latest.refreshToken) return toSessionUser(latest);
  // Another request refreshed between our snapshot and now — use its fresh token.
  if (latest.token !== session.token && !needsRefresh(toSessionUser(latest), 0)) {
    return toSessionUser(latest);
  }
  try {
    const refreshed = await refreshAccessToken(latest.refreshToken);
    updateSessionToken(
      latest.id,
      refreshed.accessToken,
      refreshed.refreshToken,
      tokenExpiryFrom(refreshed.expiresIn)
    );
    const after = getAuthSession(latest.id);
    return after ? toSessionUser(after) : null;
  } catch (err) {
    if (isDeadRefreshToken(err)) {
      // The refresh token is spent or revoked for good: drop it and keep serving
      // on the current access token until it expires, then force a re-login.
      console.warn('[requireMember] refresh token no longer valid; clearing it:', err instanceof Error ? err.message : err);
      updateSessionToken(latest.id, latest.token, null, null);
      const cleared = getAuthSession(latest.id);
      return cleared ? toSessionUser(cleared) : null;
    }
    throw err;
  }
}

function isDeadRefreshToken(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /bad_refresh_token|incorrect or expired/i.test(msg);
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
export function createSession(
  token: string,
  user: AuthUser,
  refreshToken?: string | null,
  expiresIn?: number | null,
): { id: string; cookie: string } {
  const id = randomBytes(24).toString('hex');
  const now = sqliteNow();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const tokenExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  createAuthSession({
    id, token, login: user.login, avatarUrl: user.avatarUrl,
    createdAt: now, expiresAt: expires,
    refreshToken: refreshToken ?? null, tokenExpiresAt,
  });
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
  return toSessionUser(session);
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
// membership takes effect promptly). Throws UnauthorizedError (no session),
// ForbiddenError (not a member), or GithubUnavailableError (GitHub API/network
// failure — transient, not an auth problem; the caller should surface a retry).
export async function requireMember(req: Request): Promise<SessionUser> {
  let session = getSession(req);
  if (!session) throw new UnauthorizedError('not signed in');

  // Proactive refresh: if the token is within 5 minutes of expiry, refresh now.
  // Concurrent requests share one refresh via the single-flight helper.
  if (needsRefresh(session)) {
    try {
      const refreshed = await refreshSessionSingleFlight(session);
      if (!refreshed) throw new UnauthorizedError('not signed in');
      session = refreshed;
    } catch (err) {
      console.error('[requireMember] proactive token refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  let allowed: boolean;
  try {
    allowed = await isAllowedMember(session.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[requireMember] GitHub org check failed:', msg);

    // Reactive refresh: on a 401, try one shared refresh then retry the check.
    if (/401/.test(msg)) {
      if (!session.refreshToken) {
        // No credential left to recover with: drop the session so the UI re-signs in.
        deleteAuthSession(session.id);
        throw new UnauthorizedError('github auth expired — sign in again');
      }
      let refreshed: SessionUser | null;
      try {
        refreshed = await refreshSessionSingleFlight(session);
      } catch (refreshErr) {
        console.error('[requireMember] reactive token refresh/retry failed:', refreshErr instanceof Error ? refreshErr.message : refreshErr);
        throw new GithubUnavailableError('github org check unavailable (token refresh failed)');
      }
      if (!refreshed) throw new UnauthorizedError('not signed in');
      if (refreshed.token === session.token) {
        // Refresh could not mint a new credential (token spent): force re-login.
        deleteAuthSession(session.id);
        throw new UnauthorizedError('github auth expired — sign in again');
      }
      session = refreshed;
      try {
        allowed = await isAllowedMember(session.token);
      } catch (retryErr) {
        console.error('[requireMember] org check failed after refresh:', retryErr instanceof Error ? retryErr.message : retryErr);
        deleteAuthSession(session.id);
        throw new UnauthorizedError('github auth expired — sign in again');
      }
    } else {
      throw new GithubUnavailableError('github org check unavailable');
    }
  }
  if (!allowed) {
    deleteAuthSession(session.id);
    throw new ForbiddenError('not a member');
  }
  return session;
}

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}
export class GithubUnavailableError extends Error {}

export type { AuthSession };