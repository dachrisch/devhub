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
- **TypeScript is pinned to `^5` on purpose.** `typescript-eslint` (used by the
  `eslint-config-next` typescript flat config) declares a peer range of
  `typescript >=4.8.4 <6.1.0`, so TS 7 cannot be adopted without breaking lint. Do not
  bump it.
- **eslint is pinned to `^9` on purpose.** `eslint-config-next@16` bundles
  `eslint-plugin-react@7.37.5`, which only supports eslint `^3 … ^9.7` and crashes at
  runtime under eslint 10 (`contextOrFilename.getFilename is not a function`). Revisit
  once eslint-plugin-react supports eslint 10.
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
  row is `backlog` or `closed`; it never clobbers `refinement`/`developing`/`pr`/`rollout`.
- `src/lib/github.ts` — `POST /api/issues` (refresh) ingests open issues from `dachrisch` +
  `bumbleflies`, filtered by `GITHUB_TOPICS`, skipping PRs. It also runs `sweepRollouts`,
  which advances `pr` cards to the terminal `rollout` state once their PR is merged **and** a
  release tag contains the merge commit (`GET /pulls/{n}` merged + `GET /tags` + compare).
  Manual board moves are restricted to `backlog → refinement` / `refinement → backlog`
  (`src/lib/transitions.ts`, `POST /api/issues/[id]/transition`).
- `src/lib/opencode.ts` — opencode driver. Auth header `X-Api-Key`. Model picker lists
  **all** server models (free + paid, e.g. DeepSeek V4 Flash) via `GET .../api/model`;
  pinned tiers `mimo-v2.5-free` → `big-pickle` → `nemotron-3.5-lightning-free` (provider `opencode`)
  are the fallback/failover chain with retry/backoff; the chain is sanitized
  against the server model registry before each run (missing/deprecated models
  are skipped), and refinement uses a shorter poll budget
  (`OPENCODE_REFINEMENT_POLL_TIMEOUT_MS`, default 10 min).
  Polling `GET .../message` is the completion signal; `GET .../event` SSE is streamed for the
  UI. `buildDevelopPrompt` expects repos already checked out at `WORKSPACE_ROOT/<owner>/<repo>`
  (no cloning). Final assistant message must end in a PR URL or `CANNOT FULFILL: <reason>`.
- `src/lib/develop.ts` — `startWork` (devhub#132) is the single entry point behind the "Work"
  button and routes by stage: `backlog` → refinement readiness check (opencode assesses +
  auto-refines the issue body, then develops when ready), `refinement` → re-check,
  `developing` → retry after a failed run. `startDevelop` runs fire-and-forget; it owns all
  state transitions and SSE broadcasts. `POST /api/issues/[id]/develop` returns 202
  immediately. **There is no `blocked` state**: failures keep the card in its stage and set
  `blocked_reason` ("Needs input" banner); the next Work click clears it and resumes.
  **Never re-develop an issue in `pr`/`rollout`/`closed`, and never re-develop a `developing`
  card whose run is live** (`canDevelop` allows `backlog`/`refinement`, plus `developing`
  only when `blocked_reason` is set).

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

OAuth app setup: Create a GitHub OAuth App at
https://github.com/settings/applications/new with callback
`http://localhost:3000/api/auth/callback`. After creating, ensure the app's Account
permissions grant **Read** access to Organization membership — otherwise the `read:org`
scope won't be granted and org checks fail silently (`/?auth=denied`). If login returns
`auth=denied`, unauthorize and re-authorize the app, approving all requested scopes.

## Batch Operations

The board supports batch operations for advancing multiple issues through the pipeline:

### Batch Selection
- Click checkboxes on cards to select issues
- Use `Ctrl+A` to select all visible issues
- Use `Escape` to clear selection

### Batch Actions
- **Work on selected**: run the unified Work flow (devhub#132) for each selected issue —
  backlog → refinement check → develop; failed `developing` cards retry
- **Advance selected**: Move selected issues to the next stage (backlog → refinement, refinement → backlog)

### Keyboard Shortcuts
- `Ctrl+A`: Select all visible issues
- `Escape`: Clear selection
- `Ctrl+Enter`: Advance selected issues

### Work Flow Gate
The unified Work flow (single "Work" button, `startWork`) routes by stage:
1. **Refinement**: an opencode session assesses if the issue is clear enough to implement;
   if not, it surfaces blocking questions as `blocked_reason` ("Needs input" banner) and the
   card stays in its stage; if ready it may auto-refine the issue body, then develops
2. **Develop**: a full develop session implements the issue and opens a PR

Failures never move the card backwards or to a dead state — the card stays put with
`blocked_reason` set and the next Work click resumes from there.

Every per-issue Work entry point (desktop card button, mobile card primary button,
mobile "…" sheet) opens the Start-work modal first, offering extra instructions
(prompt extension) and a model override (pre-selected with the operator's last-used
default). "Work on selected" is the exception: it starts immediately with defaults.

### E2E
Headless Work-flow e2e against mocked GitHub + opencode:
`node scripts/dev/start-dev.mjs --port 3111` then
`node scripts/dev/e2e-workflow.mjs --url http://localhost:3111`
(see `docs/plans/2026-09-02-unify-develop-flow.md`).

## Not yet verified live (from the plan)

Auto-approve behavior on `code.lehel.xyz` and whether opencode can see `WORKSPACE_ROOT`
checkouts are still open items — confirm before trusting autonomous PR creation.
