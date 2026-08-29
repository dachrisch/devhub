# DevHub

A personal, single-user **development command board**. DevHub pulls open GitHub issues from
your repos, shows them as cards on a board, and lets you dispatch an [opencode](https://opencode.ai)
session on `code.lehel.xyz` to implement an issue and open a pull request — with all status
streamed live to the UI.

> Strictly personal. No multi-tenancy, no auth beyond the operator.

## How it works

1. **Ingest** — `POST /api/issues` (Refresh) fetches open issues from `dachrisch` and the
   `bumbleflies` org whose GitHub topics intersect `GITHUB_TOPICS` (PRs are skipped).
2. **Board** — issues render in four columns: `backlog`, `developing`, `pr`, `blocked`.
3. **Develop** — "Develop this" on a card calls `POST /api/issues/[id]/develop`. The server
   opens an opencode session, streams its events, and on completion sets the issue to `pr`
   (with the PR URL) or `blocked` (with a `CANNOT FULFILL` reason).
4. **Live status** — `GET /api/stream` is a Server-Sent Events feed the board subscribes to on
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
# edit .env with your tokens
npm install
npm run dev
```

### Environment

| Variable                   | Default                  | Purpose                                            |
| -------------------------- | ------------------------ | -------------------------------------------------- |
| `OPENCODE_API_KEY`         | —                        | Auth header for `code.lehel.xyz`                  |
| `OPENCODE_BASE_URL`        | `https://code.lehel.xyz` | opencode base URL                                  |
| `GH_TOKEN`                 | —                        | PAT for `dachrisch` (repo scope)                   |
| `BUMBLEFLIES_GH_TOKEN`     | —                        | PAT for the `bumbleflies` org / private repos      |
| `GITHUB_TOPICS`           | `bumbleflies,dachrisch`  | Filter ingested repos by topic                     |
| `WORKSPACE_ROOT`           | `/home/cda/dev`          | Where repos are checked out (no cloning)           |
| `DEVHUB_DB`                | `./devhub.db`            | SQLite file (WAL mode)                             |
| `OPENCODE_ALLOW_INSECURE_TLS` | `false`              | Opt-in for self-signed opencode deployments only   |

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
| `GET`  | `/api/issues`               | List issues                               |
| `POST` | `/api/issues`              | Refresh (ingest open issues)              |
| `GET`  | `/api/issues/[id]`          | Issue detail + event log                  |
| `POST` | `/api/issues/[id]/develop`  | Start an opencode session (returns 202)   |
| `GET`  | `/api/stream`               | SSE feed of status + opencode events      |

## Project layout

```
src/lib/{env,store,github,opencode,sse,develop,types}.ts   server logic
src/app/api/...                                            route handlers
src/app/(board)/page.tsx                                   board UI
docs/plans/2026-08-30-devhub-design.md                     design plan
```

## Open items (verify before autonomous PR creation)

- Whether opencode on `code.lehel.xyz` **auto-approves** tool calls, or needs a server-side
  setting / `auto` flag.
- Whether opencode can see the `WORKSPACE_ROOT` (`/home/cda/dev`) checkouts on the same host.

See `docs/plans/2026-08-30-devhub-design.md` for the full design.

## License

[MIT](./LICENSE)
