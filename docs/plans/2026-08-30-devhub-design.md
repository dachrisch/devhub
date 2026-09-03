# DevHub — Design Plan

> Status: implemented (2026-08-30); updated 2026-09-02. Personal development
> command board. The develop flow was unified and the `blocked` state removed —
> see `2026-09-02-unify-develop-flow.md` for the current flow.

## 1. Purpose & scope

DevHub is a personal, single-user command board for managing development work. It:

1. Pulls **open GitHub issues** from repos owned by `dachrisch` / org `bumbleflies`
   (filtered by the GitHub topics `bumbleflies` and `dachrisch`).
2. Shows each issue as a **card** on a board.
3. Lets the user issue a **"develop this" command** (with optional extra instructions).
4. Spawns an **opencode session on `code.lehel.xyz`** that implements the issue in the
   correct repo and must end with **either a Pull Request or an explicit
   `CANNOT FULFILL: <reason>` statement**.
5. Holds all status server-side and **streams it to the UI over SSE**.

Strictly personal, single-user, no multi-tenancy, no auth beyond the operator.

## 2. Stack & layout

- **Next.js (App Router, React, TypeScript)** — one process serves UI + API route handlers.
- **SQLite** via `better-sqlite3` for state (no external DB).
- **undici** for opencode HTTP calls (required for the custom `dispatcher`; mirrors dontforget).
- Config via `.env`: `OPENCODE_API_KEY`, `OPENCODE_BASE_URL` (default `https://code.lehel.xyz`),
  `GH_TOKEN` (dachrisch PAT), `BUMBLEFLIES_GH_TOKEN` (org PAT),
  `GITHUB_TOPICS` (default `bumbleflies,dachrisch`),
  `WORKSPACE_ROOT` (default `/home/cda/dev` — where repos are provisioned).

Layout:

```
src/lib/{github,opencode,store,sse}.ts
src/app/api/issues/route.ts          GET list, POST refresh
src/app/api/issues/[id]/route.ts     GET detail + event log
src/app/api/issues/[id]/develop/...  POST start opencode session
src/app/api/stream/route.ts          GET SSE
src/app/(board)/page.tsx             board UI
docs/plans/2026-08-30-devhub-design.md
```

Deploy later behind Traefik on `lehel.xyz` (out of scope for v1; mirror dontforget).

## 3. Data model (SQLite)

`issues`:
`id, github_issue_id, owner, repo, number, title, body, html_url,
state, session_id, result_pr_url, result_text, blocked_reason, linked_pr_url,
release_tag, released_at, state_reason, model_id, created_at, updated_at`

`state ∈ {backlog, refinement, developing, pr, rollout, closed}` — the
`blocked` state was removed (devhub#132); stage failures keep the state and
set `blocked_reason` instead.

`events`:
`id, issue_id, kind, payload_json, ts`
— append-only log of status changes and opencode progress (tool calls, text deltas, finish).

## 4. GitHub ingestion (`src/lib/github.ts`)

On `POST /api/issues/refresh`:
- List repos for owner `dachrisch` and org `bumbleflies` (REST / `gh`), keep those whose
  `topics` intersect `GITHUB_TOPICS`.
- For each, fetch `state=open` issues, **skip pull requests**.
- Upsert into `issues` as `backlog`. **Do not clobber** rows already in
  `refinement` / `developing` / `pr` / `rollout`.

Uses `GH_TOKEN` (has `repo` scope) and `BUMBLEFLIES_GH_TOKEN` for org/private repos.

## 5. opencode driver (`src/lib/opencode.ts`)

Contract (confirmed live in sister project `dontforget/src/search/opencodeClient.ts`):

- Auth: header `X-Api-Key: <OPENCODE_API_KEY>`.
- `POST /api/session`  body `{ model: { id, providerID } }` → `{ data: { id } }`.
- `POST /api/session/:id/prompt`  body `{ prompt: { text } }` → ack.
- `GET  /api/session/:id/message` → `{ data: [<newest first>] }`; poll until an
  assistant message has `finish` set (`error` ⇒ failure).
- `GET  /api/session/:id/event` → SSE of live events (used for streaming to the UI).

Functions: `createSession(model)`, `sendPrompt(sessionId, text)`,
`streamEvents(sessionId)` (subscribes to `/event` SSE), `pollForFinish(sessionId)` (fallback).

**Model auto-discovery at startup**: call the models endpoint, filter the free tier;
pin `mimo-v2.5-free` → fallback `big-pickle` (provider `opencode`) if discovery fails.
(Mirror dontforget's measured-good free models.)

**Resilience**: retry/backoff (max 3 attempts, exponential) + model failover on
503 / 429 (provider flakiness observed live). Poll timeout generous (120s+) for agent models.

**Auto-approve**: *desired but unverified.* Live check during implementation: confirm whether
the opencode server auto-approves tool calls, or whether the prompt API accepts an `auto` flag
(or session config). If neither, we may need a server-side auto-approve setting. This is a
blocking verification item before autonomous PR creation works.

## 6. The "work" flow & prompt

`POST /api/issues/:id/develop` (body: optional `command` string) is the single
entry point behind the "Work" button. `startWork` routes by stage:
`backlog` → refinement readiness check (opencode assesses + auto-refines the
body, then develops when ready), `refinement` → re-check, `developing` →
retry after a failed run. Failures keep the card in its stage with
`blocked_reason` set (see `2026-09-02-unify-develop-flow.md`).

Backend (`startDevelop`):
1. Set `state = developing`, broadcast change.
2. Open session, subscribe to `/event` SSE → re-broadcast to UI.
3. Send a self-contained prompt (see template below).
4. On finish, capture the **last assistant message**:
   - contains a PR URL → `state = pr`, `result_pr_url` set.
   - otherwise → stay `developing`, `blocked_reason` = excerpt of the message
     (the `CANNOT FULFILL` reason).

**Prompt template** instructs opencode to:
- Operate in the already-provisioned checkout at `${WORKSPACE_ROOT}/<owner>/<repo>`
  (no cloning — repos are checked out during provisioning).
- Read the issue (title/body + user command) and use opencode dev skills
  (`using-git-worktrees`, `test-driven-development`, `writing-plans` as appropriate).
- Implement, run the repo's lint/tests.
- Open a PR via `gh` using the env PATs for the correct owner/org.
- **Always end the final message with either the PR URL or `CANNOT FULFILL: <reason>`.**

> Note: the prompt passes the repo path and issue details; opencode uses its own bash/`gh`
> tools and the workspace PATs for remote operations. `WORKSPACE_ROOT` defaults to `/home/cda/dev`.

## 7. SSE to frontend (`src/lib/sse.ts` + `/api/stream`)

`GET /api/stream` keeps an open `text/event-stream`. An in-process broadcaster pushes JSON on:
- every `issues` state change, and
- each opencode event for an active session (tool calls, text deltas, finish).

The board page subscribes on load and updates cards live. `GET /api/issues` and
`GET /api/issues/[id]` cover initial load and full history.

## 8. Error handling & guardrails

- opencode 503/429 → retry + backoff + model failover.
- session timeout → stay in stage with `blocked_reason` set.
- clone/checkout/PR failure inside opencode → `blocked_reason`, reason surfaced
  from the assistant message.
- Free models only; exactly one session per issue (a `developing` card is
  re-workable only after a failed run, i.e. `blocked_reason` set); never re-run
  a session that already produced a PR.
- **No secrets committed** — `.env.example` + `.gitignore`. `OPENCODE_API_KEY` / PATs come from env only.

## 9. Testing

- Unit: GitHub issue/PR parsing, opencode client with `fetch` mocked (per dontforget),
  SSE broadcast hub.
- E2E: headless Work-flow scenarios against mocked GitHub + opencode
  (`scripts/dev/e2e-workflow.mjs` — see `2026-09-02-unify-develop-flow.md`).
- **Mandatory live check** against `code.lehel.xyz` with the real key before trusting parsing
  (session create → prompt → message/event shape), and the auto-approve verification (§5).

## 10. Open items

1. Auto-approve behavior on `code.lehel.xyz` (verify live — §5).
2. Confirm opencode on `code.lehel.xyz` can see `WORKSPACE_ROOT` (`/home/cda/dev`) checkouts
   (same host assumption; if remote-only, mount/checkout strategy needed).
3. Exact models-listing endpoint path (discover at startup; pin known-good otherwise).
