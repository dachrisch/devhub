# DevHub

A personal, single-user **development command board**. DevHub pulls open GitHub issues from
your repos, shows them as cards on a board, and lets you dispatch an [opencode](https://opencode.ai)
session on `code.lehel.xyz` to implement an issue and open a pull request — with all status
streamed live to the UI.

> Strictly personal. Access is gated by GitHub OAuth: only members of the `bumbleflies` org can
> sign in.

## How it works

1. **Sign in** — GitHub OAuth (scopes `repo` + `read:org`). The callback only creates a session
   if you're a member of `GITHUB_ALLOWED_ORG`; the org membership is re-checked on each refresh.
2. **Ingest** — `POST /api/issues` (Refresh) fetches open issues from all repos you can access
   whose GitHub topics intersect `GITHUB_TOPICS` (PRs and bot-authored issues are skipped).
3. **Board** — issues render in four columns: `backlog`, `developing`, `pr`, `blocked`.
4. **Develop** — "Develop this" on a card calls `POST /api/issues/[id]/develop`. The server
   opens an opencode session, streams its events, and on completion sets the issue to `pr`
   (with the PR URL) or `blocked` (with a `CANNOT FULFILL` reason).
5. **Live status** — `GET /api/stream` is a Server-Sent Events feed the board subscribes to on
   load, so cards update without polling.

State lives entirely server-side in a SQLite database (`better-sqlite3`).

## Stack

- Next.js 15 (App Router, React 19, TypeScript)
- SQLite via `better-sqlite3`
- `undici` for opencode HTTP calls
- `vitest` for tests

## Requirements

- Node.js >= 20
- A C toolchain (`make`, `g++`, `python3`) — `better-sqlite3` is a native module
- Tokens (see below)

## Setup

```bash
cp .env.example .env
# edit .env with your OAuth app credentials and opencode settings
npm install
npm run dev
```

You need a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps) with
the callback URL set to `GITHUB_REDIRECT_URI` (default `http://localhost:3000/api/auth/callback`).
Scopes requested on login: `repo` (read/write your repos + issues) and `read:org`
(membership check). Localhost and production need separate apps — the callback URL
is fixed at app creation.

### Environment

| Variable                      | Default                          | Purpose                                          |
| ----------------------------- | -------------------------------- | ------------------------------------------------ |
| `OPENCODE_BASIC_USER`         | `opencode`                       | Basic-auth user for `code.lehel.xyz`            |
| `OPENCODE_BASIC_PASSWORD`     | —                                | Basic-auth password for `code.lehel.xyz`        |
| `OPENCODE_API_KEY`            | —                                | `X-Api-Key` for local opencode servers          |
| `OPENCODE_BASE_URL`           | `https://code.lehel.xyz`         | opencode base URL                                |
| `GITHUB_CLIENT_ID`            | —                                | OAuth App client ID                              |
| `GITHUB_CLIENT_SECRET`        | —                                | OAuth App client secret                          |
| `GITHUB_REDIRECT_URI`         | `http://localhost:3000/api/auth/callback` | OAuth callback URL                    |
| `GITHUB_ALLOWED_ORG`          | `bumbleflies`                    | Only members of this org may sign in             |
| `GITHUB_TOPICS`               | `gh-dash,dachrisch,bumbleflies`  | Filter ingested repos by topic                   |
| `WORKSPACE_ROOT`              | `/home/cda/dev`                  | Where repos are checked out (no cloning)         |
| `OPENCODE_WORKSPACE_ROOT`     | `/root/dev`                      | Workspace root as seen by the opencode agent     |
| `DEVHUB_DB`                   | `./devhub.db`                    | SQLite file (WAL mode)                           |
| `OPENCODE_ALLOW_INSECURE_TLS` | `false`                          | Opt-in for self-signed opencode deployments only |

## Scripts

| Command             | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Next dev server                       |
| `npm run build`     | Production build                      |
| `npm start`         | Run the production build              |
| `npm run typecheck` | `tsc --noEmit`                        |
| `npm run lint`      | `eslint .`                            |
| `npm test`          | `vitest run`                          |

Safe change order: `typecheck` → `lint` → `test` → `build`.

## API

| Method | Route                       | Purpose                                   |
| ------ | --------------------------- | ----------------------------------------- |
| `GET`  | `/api/auth/login`           | Start GitHub OAuth (redirect)             |
| `GET`  | `/api/auth/callback`        | OAuth callback (sets session, gates org)  |
| `POST` | `/api/auth/logout`          | End session                               |
| `GET`  | `/api/auth/me`              | Current signed-in user / null             |
| `GET`  | `/api/issues`               | List issues (auth required)               |
| `POST` | `/api/issues`              | Refresh / ingest open issues (auth)       |
| `GET`  | `/api/issues/[id]`          | Issue detail + event log (auth required)  |
| `POST` | `/api/issues/[id]/develop`  | Start an opencode session, returns 202    |
| `GET`  | `/api/stream`               | SSE feed of status + opencode events      |

## Project layout

```
src/lib/{env,store,github,opencode,sse,develop,types,auth}.ts   server logic
src/app/api/auth/...                                            OAuth routes
src/app/api/...                                                route handlers
src/app/(board)/page.tsx                                       board UI
src/components/{logo,auth-ui,use-auth}.tsx                     UI components
src/components/board/{mobile-card,card-actions-sheet,          mobile board UI (<768px) + shared
  mobile-status-strip,mobile-search-sheet,use-card-actions,     develop/transition logic
  use-media-query,develop-modal}.tsx
docs/plans/2026-08-30-devhub-design.md                         design plan
docs/plans/2026-08-30-github-oauth-login.md                     auth plan
```

## Open items (verify before autonomous PR creation)

- Whether opencode on `code.lehel.xyz` **auto-approves** tool calls, or needs a server-side
  setting / `auto` flag.
- Whether opencode can see the `WORKSPACE_ROOT` (`/home/cda/dev`) checkouts on the same host.
- How the operator's OAuth token reaches opencode's `gh pr create` (the develop prompt now
  assumes opencode's own authenticated `gh`).

See `docs/plans/2026-08-30-devhub-design.md` for the full design.

## License

[MIT](./LICENSE)
