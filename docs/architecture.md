# DevHub — Architecture & User Interaction

> A personal Kanban board that turns GitHub issues into pull requests — powered by AI agents, real-time streaming, and a single SQLite database.

**Interactive version:** [docstash.ai/gq0b04](https://app.docstash.ai/gq0b04)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router), React 19, Node.js ≥ 20 |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Auth | GitHub OAuth (`repo` + `read:org`), org-gated |
| AI Agent | opencode (sessions, prompts, SSE, model failover) |
| Real-time | Server-Sent Events via in-process `Broadcaster` |
| Testing | Vitest with per-run temp DBs |

---

## System Architecture

```
┌─────────┐      OAuth + SSE      ┌──────────────┐      SQL      ┌────────┐
│ Browser │ ◄──────────────────► │  Next.js      │ ◄──────────► │ SQLite │
│ React UI│                      │  Server       │              │        │
└─────────┘                      └──────┬───────┘              └────────┘
                                        │
                         ┌──────────────┼──────────────┐
                         │              │              │
                    ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐
                    │ GitHub  │   │ opencode  │  │ Browser │
                    │ API     │   │ AI Agent  │  │ SSE     │
                    └─────────┘   └───────────┘  └─────────┘
```

Three external systems (GitHub, opencode, Browser) connect to a single Next.js server backed by SQLite.

---

## Issue Lifecycle (Pipeline)

```
📥 Backlog → 🔍 Refinement → 🛠️ Developing → 🔀 PR → 🚀 Rollout
                                                   ↘ 🚫 Blocked
                                                   ↘ 📭 Closed
```

| Stage | Description |
|-------|-------------|
| **Backlog** | Ingested from GitHub repos matching `GITHUB_TOPICS` |
| **Refinement** | Scoping & validation — issue assessed for readiness |
| **Developing** | AI agent working — creates worktree, implements, tests |
| **PR** | Pull request open — waiting for merge |
| **Rollout** | Merged + release tag contains merge commit |
| **Blocked** | AI couldn't fulfill — error text stored |
| **Closed** | Resolved on GitHub |

Manual transitions are limited to `backlog ↔ refinement`.

---

## User Interactions

### 1. Sign In
GitHub OAuth with `repo` + `read:org` scopes. Only `bumbleflies` org members allowed. Token stays server-side.

### 2. Refresh Board
`POST /api/issues` triggers full GitHub sync — fetches repos, upserts issues, finds linked PRs, sweeps rollouts, reconciles closed issues.

### 3. Browse & Search
Kanban columns: backlog, refinement, developing, pr, blocked. Full-text search across titles, bodies, and repos.

### 4. Validate
Gates development — an AI session assesses if the issue is clear enough to implement. Passes with `READY:` or returns `NEEDS_WORK:` feedback.

### 5. Develop This
Opens a modal with instructions + model picker. Fires a fire-and-forget session that:
- Creates a git worktree at `.worktrees/{issueId}`
- Implements the feature
- Runs lint + tests
- Opens a PR
- Cleans up the worktree

### 6. Cockpit
Natural language command bar — type "Launch a new API" or "Fix issue #42". Intent is classified via LLM and dispatched to pluggable skills.

### Batch Operations
Select multiple cards (checkboxes or `Ctrl+A`), then advance, validate, or develop them together.

---

## Data Flow

### GitHub → SQLite (Ingestion)
1. `POST /api/issues` → `refreshIssues()` in `src/lib/github.ts`
2. Fetches repos filtered by `GITHUB_TOPICS`
3. Upserts issues — only updates metadata when in `backlog` state
4. Searches for linked PRs per issue
5. Sweeps rollouts: merged PR + release tag → `rollout` state
6. Reconciles closed issues with GitHub
7. Mirrors DevHub state as `devhub:*` labels on GitHub

### Server → Browser (SSE)
1. In-process `Broadcaster` on `globalThis` — survives HMR
2. Three event types: `issue`, `opencode-event`, `action`
3. `GET /api/stream` sends `text/event-stream`
4. Client upserts React state on each event
5. Browser notifications for `pr` and `blocked` transitions

### Develop Flow
1. `POST /api/issues/[id]/develop` → returns 202
2. Sets state → `developing`, mirrors labels on GitHub
3. Resolves model: user pick → fallback chain (`mimo-v2.5-free` → `deepseek-v4-flash` → `big-pickle` → ...)
4. Builds prompt with worktree + branch instructions
5. Creates opencode session, streams events via SSE
6. Polls for completion, extracts PR URL
7. Advances to `pr`, `closed`, or `blocked`

---

## Authentication Flow

1. **Redirect to GitHub** — `GET /api/auth/login` builds authorize URL, CSRF nonce in httpOnly cookie
2. **Callback & Token Exchange** — `GET /api/auth/callback` verifies CSRF, exchanges code for access token
3. **Org Membership Check** — Fetches `GET /user/orgs`, verifies `bumbleflies` membership (3× retry with backoff)
4. **Session Created** — DB session (30-day TTL) in `auth_sessions`, client gets session cookie only
5. **Per-Request Verification** — `getSession()` reads cookie → DB lookup; `requireMember()` re-checks org on mutating endpoints

---

## Key API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/auth/me` | Current user or null |
| `POST` | `/api/issues` | Full GitHub sync (refresh) |
| `GET` | `/api/issues` | All issues from SQLite |
| `POST` | `/api/issues/[id]/develop` | Start AI development (202) |
| `POST` | `/api/issues/[id]/validate` | Run validation only |
| `POST` | `/api/issues/[id]/transition` | Manual state change |
| `POST` | `/api/issues/batch-advance` | Batch advance/validate/develop |
| `GET` | `/api/stream` | SSE event stream |
| `GET` | `/api/models` | Available AI models |
| `POST` | `/api/action` | Cockpit command |

All routes use `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`.

---

## Key Design Decisions

- **Single Database** — SQLite with WAL mode. All state in one file: issues, events, sessions, knowledge.
- **Server-Side Tokens** — OAuth tokens never reach the browser. GitHub API calls use user's token, not PATs.
- **Fire-and-Forget** — `POST /develop` returns 202 immediately. Development runs async with SSE progress.
- **Model Failover** — Chain of models with 3 retries each and exponential backoff.
- **Stuck Recovery** — Issues stuck in `developing` on server restart are moved to `blocked`.
- **Pluggable Skills** — Registry with `launch` (service deployment) and `fix` (issue resolution) skills.
- **Knowledge Memory** — FTS5-backed long-term storage for skill execution results.

---

## Source References

| Component | File |
|-----------|------|
| SQLite schema & access | `src/lib/store.ts` |
| GitHub API & ingestion | `src/lib/github.ts` |
| opencode driver | `src/lib/opencode.ts` |
| Develop orchestration | `src/lib/develop.ts` |
| Auth & sessions | `src/lib/auth.ts` |
| SSE broadcaster | `src/lib/sse.ts` |
| State transitions | `src/lib/transitions.ts` |
| Cockpit router | `src/lib/router.ts` |
| Board UI | `src/app/(board)/page.tsx` |
| Issue detail | `src/app/(board)/issues/[id]/page.tsx` |
| Develop modal | `src/components/board/develop-modal.tsx` |
