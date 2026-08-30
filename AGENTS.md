# AGENTS.md

Personal, single-user dev command board (Next.js 15 App Router + better-sqlite3 + opencode).
No auth, no multi-tenancy. The live design plan is `docs/plans/2026-08-30-devhub-design.md`.

## Commands

- `npm run dev` / `npm run build` / `npm start` — Next.js (node server).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — **`eslint .`**, not `next lint` (the latter is deprecated here and
  breaks under TypeScript 7).
- `npm test` — `vitest run` (config sets `fileParallelism: false`).

Order for a safe change: `typecheck` → `lint` → `test` → `build`.

## Toolchain gotchas (verified the hard way)

- **Relative imports must be extensionless** (`import { x } from './store'`). A `./store.js`
  specifier compiles under `tsc` and resolves in vitest, but **fails the Next/webpack
  build** (`Module not found`). Use the `@/lib/...` alias or extensionless paths only.
- **TypeScript is pinned to `^5` on purpose.** Next 15 rejects TS 7's native compiler; do
  not bump it.
- **`better-sqlite3` is a native module** — needs a C toolchain (`make`/`g++`) to
  `npm install`. It is listed in `serverExternalPackages` in `next.config.mjs`; never remove
  that or the server build breaks.
- DB path via `DEVHUB_DB` (default `./devhub.db`, WAL mode). Tests use per-run temp files in
  `os.tmpdir()`.

## Next.js App Router specifics

- Every API route sets `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'` (better-sqlite3 + SSE need the Node runtime, no
  static optimization).
- Route `params` is a **Promise** in Next 15: `async (req, { params }) => { const { id } =
  await params }`.
- SSE: `GET /api/stream` returns a `text/event-stream` driven by the in-process
  `broadcaster` in `src/lib/sse.ts` (persisted on `globalThis` across HMR).

## Domain wiring

- `src/lib/store.ts` — SQLite (`issues`, `events`). `upsertIssue` only writes metadata when a
  row is `backlog`; it never clobbers `developing`/`pr`/`blocked`.
- `src/lib/github.ts` — `POST /api/issues` (refresh) ingests open issues from `dachrisch` +
  `bumbleflies`, filtered by `GITHUB_TOPICS`, skipping PRs.
- `src/lib/opencode.ts` — opencode driver. Auth header `X-Api-Key`. Model tiers
  `mimo-v2.5-free` → `big-pickle` (provider `opencode`) with retry/backoff + failover.
  Polling `GET .../message` is the completion signal; `GET .../event` SSE is streamed for the
  UI. `buildDevelopPrompt` expects repos already checked out at `WORKSPACE_ROOT/<owner>/<repo>`
  (no cloning). Final assistant message must end in a PR URL or `CANNOT FULFILL: <reason>`.
- `src/lib/develop.ts` — `startDevelop` runs fire-and-forget; it owns all state transitions
  and SSE broadcasts. `POST /api/issues/[id]/develop` returns 202 immediately. **Never
  re-develop an issue in `pr` state** (`canDevelop` only allows `backlog`/`blocked`).

## Env

Copy `.env.example` → `.env`. Required: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
(GitHub OAuth App) and opencode credentials (`OPENCODE_BASIC_PASSWORD` for
`code.lehel.xyz`, or `OPENCODE_API_KEY` for a local server). `OPENCODE_ALLOW_INSECURE_TLS=true`
only for the opt-in insecure deployment (not production `code.lehel.xyz`).

Auth: GitHub OAuth (scopes `repo` + `read:org`). Only members of `GITHUB_ALLOWED_ORG`
(=`bumbleflies`) get a session. Sessions live in the `auth_sessions` table; the OAuth
token is server-side only. `src/lib/auth.ts` owns cookies + membership checks; the
`/api/auth/*` routes own the flow. All `/api/issues*` and `/api/stream` require a session;
`POST /api/issues` and `POST /api/issues/[id]/develop` additionally re-check org membership.
GitHub API calls in `src/lib/github.ts` take the token as an argument — never read env PATs.

## Not yet verified live (from the plan)

Auto-approve behavior on `code.lehel.xyz` and whether opencode can see `WORKSPACE_ROOT`
checkouts are still open items — confirm before trusting autonomous PR creation.
