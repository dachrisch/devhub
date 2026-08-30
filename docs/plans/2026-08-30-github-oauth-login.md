# DevHub — GitHub OAuth login (replace static PATs)

> Status: proposed (2026-08-30). Companion to `2026-08-30-devhub-design.md`.

## 1. Goal

Replace the static `GH_TOKEN` / `BUMBLEFLIES_GH_TOKEN` PATs with a **GitHub OAuth
login**: the operator signs in with their GitHub account, and the app uses that
user's access token to list repos + ingest issues. One token (with `repo` +
`read:org` scope) covers both the user's own repos and the `bumbleflies` org repos
the user can access — so the two PATs collapse into one OAuth token.

**Authorization gate**: only GitHub users who are members of the `bumbleflies`
org may use the service (§2). Authentication (who you are) and authorization
(bumbleflies membership) are both enforced server-side.

Out of scope for this change (separate live item, see §7): passing the token to
opencode for `gh pr create`. This plan only replaces the *ingestion* credential.

## 2. Auth flow

Create a **GitHub OAuth App** (not a GitHub App — simpler, single-user, no webhook
machinery). Callback: `/api/auth/callback`.

Routes:

- `GET  /api/auth/login` — 302 to `https://github.com/login/oauth/authorize`
  with `client_id`, `redirect_uri`, `scope=repo read:org`, and a `state` nonce.
- `GET  /api/auth/callback?code&state` — exchange `code` for a token
  (`POST https://github.com/login/oauth/access_token`, Accept `application/json`),
  verify `state`, fetch `/user` (login/avatar for the header), **check bumbleflies
  membership**, and only then store a session, set the cookie, redirect to `/`.
  Reject otherwise → redirect `/?auth=denied` (§6).
- `POST /api/auth/logout` — delete session, clear cookie.
- `GET  /api/auth/me` — `{ user: {...} | null }` for the header state.

CSRF: the `state` nonce is stored in a short-lived httpOnly cookie and must match
on callback.

### Authorization: bumbleflies membership check

The service is operator-only: a GitHub user must be a **member of the
`bumbleflies` org** to use DevHub. Enforcement:

- After token exchange, call `GET /user/orgs` (needs `read:org` scope) and require
  the response to include `bumbleflies` (org login). Case-insensitive match.
- **No session is created for non-members.** They are redirected to
  `/?auth=denied` — no cookie, no token stored. The `repo`-only token they get
  from a malicious login is useless without a stored session.
- **Re-verified on refresh** (§5): each `POST /api/issues` re-checks membership
  with the session token (one extra `GET /user/orgs` call) so revoked membership
  takes effect promptly. (Cheap; rate-limit budget is fine for personal use.)
- The members are enumerated from the token's own orgs list — no org admin
  credential or hardcoded allow-list needed; membership is evaluated against the
  live `bumbleflies` org.

## 3. Session storage

Add a `auth_sessions` table to SQLite (we already own the DB; named to avoid
clashing with `issues.session_id`, which is the opencode session):

```
auth_sessions: id TEXT PRIMARY KEY, token TEXT NOT NULL, login TEXT, avatar_url TEXT,
               created_at TEXT, expires_at TEXT
```

- `id` = random 32-byte hex; set as `devhub_session` httpOnly cookie,
  `SameSite=Lax`, `Secure` when `NODE_ENV === 'production'`, ~30d expiry.
- The OAuth access token lives **only server-side** in the table (never in the
  cookie or the client). Server restarts survive (it's in SQLite). Plaintext is
  acceptable under the current threat model (the PATs it replaces were plaintext
  env vars); no extra-at-rest encryption for v1.
- New `src/lib/auth.ts`: `createSession`, `getSession(id)`, `destroySession(id)`,
  plus `requireSession(req)` returning `{ token, user }` or null, where `user` is
  `{ login, avatarUrl }` (serves `/api/auth/me` and the header avatar).
- `createSession` also purges any `auth_sessions` rows with `expires_at` in the
  past (tiny opportunistic cleanup, no cron).

## 4. GitHub client changes (`src/lib/github.ts`)

All three GitHub-touching functions move from `ENV` PATs to an explicit token:

- `refreshIssues(token, fetchFn)` — token passed in from the session.
- `setIssueStateLabels(owner, repo, number, state, token, fetchFn)` — state
  mirroring (devhub:* labels) currently uses `tokenForOwner` → same PAT source;
  switch to the session token.
- `commentOnIssue(owner, repo, number, body, token, fetchFn)` — same.
- Delete `tokenForOwner` (no more two-token dispatch).

Repo discovery with the OAuth token:

- Prefer a single call `GET /user/repos?affiliation=owner,organization_member&sort=updated`
  → returns repos the user owns **plus** org repos they can access. Filter by
  `GITHUB_TOPICS` as today. (Master already switched `/orgs/...` → `/users/...`
  for the user owner; `GET /user/repos` removes the distinction entirely.)
- New helper `isAllowedMember(token, fetchFn)` → `GET /user/orgs`, checks
  `GITHUB_ALLOWED_ORG` membership (used by callback + refresh re-check).

Issues, upsert, bot/PR filtering stay unchanged.

`ENV.ghToken` / `ENV.bumblefliesGhToken` are **removed** from the ingestion path
and from `env.ts` entirely (no fallback — no-auth means "not signed in"). The
opencode server keeps its own `gh` credentials for PR creation (§7).

## 5. Route guards

- `POST /api/issues` (refresh): require a valid session → 401 `{ error: 'not signed in' }`
  if absent; otherwise `refreshIssues(token)`.
- **Membership re-check**: before refreshing, re-verify bumbleflies membership via
  `GET /user/orgs` with the session token. Non-member (revoked) → destroy session,
  403 `{ error: 'not a bumbleflies member' }`.
- `POST /api/issues/[id]/develop`: also requires a session (any issue ops are
  operator-only). The session token is threaded into `startDevelop(issue, command, token)`
  so the state-mirroring labels/comments use the operator's credential.
- **GitHub 401 handling**: if the OAuth token is revoked/expired, GitHub returns
  401 on the first repo/issue call. Catch that in the refresh route, destroy the
  session, and return 401 `{ error: 'github auth expired — sign in again' }` so
  the UI flips back to the signed-out header instead of showing a generic 502.
- GET endpoints (`/api/issues`, `/api/issues/[id]`, `/api/stream`) and the board
  page also require a session → 401 when signed out. The welcome screen is pure
  client-side sugar; the server-side gate is what actually enforces
  "bumbleflies members only". The board page renders as a server component that
  reads the cookie (or the client checks `/api/auth/me`); either way, no issue
  data is served to non-members.

## 6. UI (`src/app/(board)/page.tsx`)

- Header: on load `GET /api/auth/me` →
  - signed out: "Sign in with GitHub" link (`/api/auth/login`).
  - signed in: **avatar + login + "Sign out"** (`POST /api/auth/logout`).
- **Avatar**: render the GitHub avatar (`avatar_url` from `/user`, stored in the
  session row). 32×32 rounded `<img>` (GitHub returns ~40px; request
  `?size=64` for crispness). Alt/title = login. Fallback if `avatar_url` missing:
  an inline SVG circle with the first initial of the login, styled with
  `var(--accent)`.
- Header layout stays `space-between`: left = DevHub title, right = a flex row of
  `[connection dot] [avatar] [login] [refresh] [sign out]`. Use the existing
  `--muted` / `--border` tokens; avatar gets a 1px `var(--border)` ring so it
  reads on the dark bg.
- Disable "Refresh issues" until signed in; handle 401 from refresh by flipping
  back to the signed-out header state.

### Welcome screen (signed-out state)

When `/api/auth/me` returns null, render a centered **welcome screen** instead of
the board. The board itself is never shown to signed-out users; GET endpoints are
also session-gated (§5), so the welcome screen is presentation, not the only
enforcement — no issue data reaches non-members.

- Large logo mark, "DevHub", tagline ("Personal development command board").
- Primary "Sign in with GitHub" button → `/api/auth/login`, styled with the
  GitHub mark (inline SVG) + text, `--accent` background on hover.
- Matches the existing dark theme tokens (`--bg`, `--panel`, `--border`).

### Access-denied state (`/?auth=denied`)

When the callback rejects a non-member, the welcome screen shows an
**access-denied variant** (read `?auth=denied` in the client): logo + "Access
denied — only `bumbleflies` org members can use DevHub." with a hint to sign in
as a member account. No other UI state is exposed.

### Logo + favicon

- **Logo**: a single inline SVG mark used everywhere (no binary assets). A
  rounded-square badge with a simple glyph (e.g. a lightning bolt / terminal
  prompt `>` on a card) in `--accent` on `--bg` or `--panel`. New
  `src/components/logo.tsx` exporting `Logo({ size })`.
- **Favicon**: Next 15 App Router file convention — `app/icon.svg` serving the
  same mark (auto-served at `/icon.svg`, dark bg + accent glyph so it reads in
  both browser tabs and dark-mode bookmarks). No manifest/manifest.json needed
  for v1.
- Header: the DevHub `<h1>` text is replaced by `Logo` + wordmark (login/avatar
  row already covered above).

## 7. opencode / develop flow — open item

The develop prompt (§5 of the design plan) tells opencode to run `gh pr create`
using "the env PAT". opencode runs on the remote `code.lehel.xyz` server; the
OAuth token stored in *this* app's SQLite is not automatically available there.

Options (do **not** bake into this change):
1. Pass the token into the opencode session env/config — requires verifying the
   session API accepts per-session env (ties into the auto-approve verification).
2. Keep `gh` authenticated on the opencode server independently (provisioned via
   its own credential) — prompt text just says "use your authenticated `gh`".
3. Have this app create the PR itself after the session completes (token is
   already here).

Pick after the live opencode checks are done; until then the develop flow keeps
working as today.

**Regardless of that choice**: `buildDevelopPrompt` (opencode.ts) currently
instructs opencode to "Use the GitHub PAT from the environment" — that instruction
is stale the moment the PATs leave this app's env. Re-word it to "use your
authenticated `gh`" (matching the pre-provisioned checkout) as part of this
change.

## 8. Env / .env.example

```
# --- GitHub OAuth ---
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
GITHUB_REDIRECT_URI=http://localhost:3000/api/auth/callback
# Allowed org for authorization (default bumbleflies)
GITHUB_ALLOWED_ORG=bumbleflies
```
- Remove `GH_TOKEN` / `BUMBLEFLIES_GH_TOKEN` (or keep documented only as
  optional opencode-server provisioning creds, not app env).

Deliverables include updating the README: the env table (§ currently listing
`GH_TOKEN` / `BUMBLEFLIES_GH_TOKEN`) becomes the OAuth vars, and a "Sign in with
GitHub" note is added to the setup steps.

## 9. Testing

- Update `github.test.ts`: `refreshIssues(token, fetchFn)` — mock fetch for
  `/user/repos` (topic filter + PR skip unchanged), token threading asserted.
- New `auth.test.ts`: session create/get/destroy against temp DB; callback
  token-exchange with `fetch` mocked; `requireSession` on missing/expired session;
  **membership gate** — mock `/user/orgs` without `bumbleflies` → no session
  created, `/user/orgs` with `bumbleflies` → session created; refresh re-check
  denies a revoked member.
- Manual: real OAuth login on localhost against a throwaway OAuth App; refresh
  with a token that can't see `bumbleflies` returns only the user's repos; a
  non-member account is rejected at the callback with `/?auth=denied`.
- UI smoke: signed-out → welcome screen + favicon renders; signed-in → board with
  avatar in header; logout returns to welcome.

## 10. Risks / notes

- **Scope**: `repo` grants read to private repos and write (needed later for PRs);
  `read:org` enables the membership check. Both are read/write-ish but limited to
  the signed-in user's own grants. Personal app, operator-only — acceptable.
- **Authorization**: enforced at callback (no session for non-members) and
  re-checked on each refresh, so a revoked member is cut off promptly. All data
  endpoints (GET + POST) are session-gated; only the OAuth callback and login
  redirect are anonymous.
- Token is long-lived (no refresh tokens for OAuth App web flow); revocation =
  revoke the OAuth app grant in GitHub settings or delete the session row.
- OAuth App callback URL is fixed at creation; localhost + prod need two apps
  (or a second redirect entry) — note in README.