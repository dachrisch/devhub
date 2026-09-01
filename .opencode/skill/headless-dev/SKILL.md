---
name: headless-dev
description: Start DevHub locally in dev mode with mocked GitHub and generic seeded data, then drive/verify it with headless Chrome (CDP). Use when the DevHub app must run without real GitHub credentials or OAuth login, e.g. for UI automation, screenshots, or E2E checks.
---

# Headless DevHub dev server (mocked GitHub + seeded data)

## What the harness does

`scripts/dev/` contains a zero-app-code-change harness:

| File | Role |
|---|---|
| `scripts/dev/start-dev.mjs` | One-stop launcher: seeds the DB, patches `fetch` to mock GitHub, spawns `next dev`, waits for readiness. |
| `scripts/dev/mock-github.cjs` | `NODE_OPTIONS --require` preload that intercepts all `api.github.com` / `github.com` requests in the server process and returns generic JSON (user `octocat`, orgs `[bumbleflies]`, 3 repos, 6 issues each). |
| `scripts/dev/seed.mjs` | Creates/updates `DEVHUB_DB` with a **fixed auth session** and 10 generic issues across every board state (backlog/refinement/developing/pr/blocked/rollout). |
| `scripts/dev/headless-check.mjs` | Launches headless Chromium over raw CDP (no puppeteer needed), injects the session cookie, loads the board, asserts content, saves a screenshot. |

## Start the app

```sh
node scripts/dev/start-dev.mjs --port 3111
# env knobs: PORT, DEVHUB_DB (default ./.devhub-dev.db, gitignored), DEVHUB_MOCK_GITHUB=0 to disable
```

When the banner prints, the server is ready at `http://localhost:<port>`.

- **No OAuth needed.** Auth is cookie-based: `devhub_session=dev-headless-session-0001`
  (user `octocat`). The session row lives in the seeded SQLite DB.
- **Mocked refresh:** `POST /api/issues` with that cookie ingests the mock GitHub data
  (3 repos × 6 issues) instead of hitting real GitHub. Edit `MOCK_ISSUES` /
  repo list in `mock-github.cjs` or the `ISSUES` array in `seed.mjs` to change
  the generic data (keep `seed.mjs` owner/repo/number in sync with the mock so
  refresh reconciles instead of duplicating).
- All other env (OPENCODE_*, GITHUB_*) is unnecessary for this mode; the develop
  flow will still fail unless opencode credentials exist — mock only covers GitHub.

## Verify / drive with headless Chrome

```sh
node scripts/dev/headless-check.mjs --url http://localhost:3111 \
  [--screenshot out.png] [--expect "Some card title"] [--session dev-headless-session-0001]
```

Exits 0 with `PASS` when the board shows the signed-in user and seeded cards.
Needs a Chromium binary: `CHROMIUM_BIN` env or `chromium-browser`/`chromium`/
`google-chrome` on PATH (Alpine: `apk add chromium`). Running as root requires
the script's `--no-sandbox` flag (already included).

### CDP recipe (for custom automation)

Node ≥22 has a built-in WebSocket, so no driver deps are required:

1. Launch: `chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=0 --user-data-dir=<tmp> about:blank`
2. Read stderr line `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`.
3. `Target.createTarget` → `Target.attachToTarget {flatten:true}` → use the `sessionId` on all calls.
4. `Network.setCookie {name:'devhub_session', value:'dev-headless-session-0001', url:'http://localhost:<port>'}`
5. `Page.navigate` → wait `Page.loadEventFired` → allow ~2–6s for hydration, then `Runtime.evaluate` / `Page.captureScreenshot`.

## CRITICAL gotcha: use `localhost`, never `127.0.0.1`

Next 16 dev **blocks "cross-origin" dev resources** (e.g. the `/_next/hmr`
websocket) for any host other than `localhost` — accessing the server via
`http://127.0.0.1:<port>` makes the HMR websocket fail with
`net::ERR_INVALID_HTTP_RESPONSE`. In Next ≥16.2 the RSC `debugChannel`
(react-server-dom-turbopack) then **hangs hydration forever and silently**: the
SSR shell renders, zero JS errors, `useEffect` never fires, the page stays
static (upstream: vercel/next.js discussion #91770, issue #94075).

`start-dev.mjs` and `headless-check.mjs` therefore use/force `localhost`
everywhere. If you write your own automation, do the same — `curl` works fine
over `127.0.0.1`, which hides the problem until a real browser is used.

## Stop

Kill the `start-dev.mjs` process (it forwards SIGINT/SIGTERM to `next dev`):

```sh
pkill -f "start-dev.mjs"   # from a shell whose own cmdline doesn't match the pattern
```
