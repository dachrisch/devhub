# Agent Activity ingest/query contract (devhub#270 / #271)

DevHub owns the receiving side. The laptop producer (`agent-relay`, canonical in
**setup-home** `agent-config/`) mirrors this document. This is the contract of
record; if the relay and this file disagree, the relay is wrong.

## Endpoints

### `POST /api/activity/ingest`

Authed by the shared secret header `X-Activity-Token` (constant-time compared
against `ACTIVITY_INGEST_TOKEN`). Returns `202 {ok,sessions,events}`. Missing or
blank `ACTIVITY_INGEST_TOKEN` → `503` (ingest disabled). Bad/missing token →
`401`. Unusable envelope → `400`.

Semantics:

- **Latest `updatedAt` wins** per `(source, sessionId)`. A replay of a stale
  spool never clobbers newer state.
- **Events are append-only and idempotent**, deduped on
  `(source, sessionId, ts, type)`.
- **Every batch is a heartbeat** for `source`; there is no separate heartbeat
  field. The connection alone proves liveness.
- A batch with only a heartbeat (no sessions/events/history) is valid.
- Malformed individual sessions/events are dropped; the batch still lands.

### `GET /api/activity`

GitHub member-gated (`requireMember`). Returns the live fleet and (from
devhub#273) history aggregates:

```jsonc
{ "fleet": [ /* ActivitySession rows */ ],
  "history": [ /* daily rollups; empty until #273 */ ],
  "generatedAt": "ISO-8601" }
```

### SSE

`/api/stream` emits id-notifications `{type:'activity', source}` (a batch
landed) and `{type:'activity-heartbeat', source}`. Clients refetch
`GET /api/activity`; no polling.

## Payload

```jsonc
{ "source": "laptop", "sentAt": <ms>,
  "sessions": [{
    "harness": "claude" | "opencode", "sessionId": "...",
    "project": "/home/cda/dev/...", "repo": "owner/name", "branch": "...",
    "model": "...", "agent": "build",
    "status": "working" | "needs-input" | "idle" | "done" | "error",
    "activity": "edit src/x.ts", "startedAt": <ms>, "updatedAt": <ms>,
    "tokens": {"input","output","reasoning","cacheRead","cacheWrite","contextUsed","contextLimit"},
    "cost": 0.0, "costKind": "reported" | "estimated", "messages": 0, "toolCalls": 0 }],
  "events": [{ "sessionId": "...", "ts": <ms>, "type": "...", "tool": "...", "text": "..." }],
  "history": { /* optional producer aggregates, e.g. Claude stats-cache */ } }
```

Rules:

- `source` is required and non-blank; it keys heartbeats and, with `sessionId`,
  the session row.
- `sessionId` is required per session; unknown/missing harness defaults to
  `opencode`, unknown/missing status defaults to `idle`.
- `costKind` is per source: opencode = `reported`, Claude = `estimated`.
  **Cost must never be summed across provenances.**
- `tokens.contextUsed` / `contextLimit` feed the context meter; only numeric
  values are stored.
- `history` is opaque to the receiver; stored on `activity_source` and rolled up
  in #273. It is preserved when a later batch omits it.

## Storage

`store.migrate()` creates:

- `activity_session` — current fleet, PK `(source, session_id)`.
- `activity_event` — append-only history, UNIQUE `(source, session_id, ts, type)`.
- `activity_source` — `(source PK, last_heartbeat, sent_at, last_cursor, history_json)`.

## Environment

| var | meaning |
| --- | --- |
| `ACTIVITY_INGEST_TOKEN` | shared secret; empty disables ingest (503) |

## Producer (setup-home `agent-relay`)

Zero-dependency (`node:sqlite` + global `fetch`). Reads the laptop's local
opencode DB and `~/.claude` transcripts, batches current state + events, POSTs
here, and spools offline until the endpoint is reachable. Claude cost is
estimated from a local price table. `agent_relay_token` in the setup-home vault
must equal DevHub's `ACTIVITY_INGEST_TOKEN`.
