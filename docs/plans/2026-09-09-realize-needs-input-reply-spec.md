# Spec: answer Realize blockers inline on the idea page (2026-09-09)

Status: spec, not implemented. Unblocks the needs-input thread-lock gap left
out of the unified-funnel build (review §1.6, redesign doc §"Not designed yet"
§1). Same branch (`docs/hub-user-journey-review`); implement on top of
`2405171`.

## Problem

When a realize run blocks, the idea page says "Answer above — work resumes on
its own," but there is no "above" to answer in:

- `threadLocked = dropped|shipped|realizing` hides the reply box **and** the
  Choose buttons for the whole realization (`topics/[id]/page.tsx`).
- `POST .../messages` rejects non-`new|shaping|ready` with 400 read-only and
  `POST .../choose` rejects `realizing` — the block is enforced server-side too.
- The only resume paths today are the "Resume realizing" button (retry with no
  new input) and leaving for the board/recap to Work the issue with extra
  instructions. The user's answer never reaches the agent from the idea page.

## Decision

Unlock the thread **exactly while input is needed**, and route the answer into
the resume. No new event types, no new tables, no shaping changes.

- Locked iff `dropped | shipped | (realizing && !needsInput)`, where
  `needsInput = linked issues.some(i => i.blockedReason)` — the same predicate
  behind `stageFor`'s `needs-input` and the timeline note.
- A reply/choice posted while unlocked-during-realizing stores normally **and**
  resumes the realize loop with the answer as its command. The timeline note
  becomes literally true.
- Mid-run chatter (realizing, nothing blocked) stays locked — no noise while
  the agent works.

## Behavior

### POST .../messages (reply)

| Topic state | Behavior |
|---|---|
| `new/shaping/ready` | Unchanged: store + `runShapingRound`, 202 `{ message }`. |
| `realizing` + blocked linked issue | Store + resume loop fire-and-forget with `command = reply text`. 202 `{ message, resumed: true }`. Loop already live (double-submit race) → store only, 202 `{ message, resumed: false }`. |
| `realizing`, nothing blocked | Unchanged 400 read-only. |
| `dropped/shipped` | Unchanged 400. |

Never run shaping for a realizing reply. Token comes from `requireMember`
(already available, currently discarded on this route).

### POST .../choose (one-click option)

Same unlock matrix. On `realizing` + blocked: record the pick (as today) but
**skip** the `shapedSummary` rewrite — the summary is shaping history, and the
pick's content travels as the resume command instead
(`"Chosen option: <title> — <desc>"`). Response gains additive
`resumed: true|false`. All other statuses unchanged.

### Resume core (`src/lib/realize.ts`)

```ts
export function shouldResumeOnReply(
  status: Topic['status'],
  issues: Issue[],
  live: boolean
): boolean // status === 'realizing' && !live && issues.some(i => i.blockedReason)
```

Callers (`messages`, `choose` routes) check it, then fire-and-forget
`realizeTopic(topicId, token, { command })` — the same entry the realize route
uses. `canRealize` already maps blocked → `full`, and `startWork` targets the
blocked/developable issue, so no develop-flow changes are needed.

Multi-blocked note (documented limitation): the answer goes to whichever issue
the resume targets (`find(canDevelop) ?? [0]`). The reply hint names it (below)
so the user isn't guessing.

### Idea page (`topics/[id]/page.tsx`)

- `threadLocked` adopts the unlock rule. Unknown state (issues still loading)
  defaults to locked.
- Reply box reappears with placeholder "Answer the blocker — work resumes on
  its own" plus a muted line naming the target:
  `Answering <owner>/<repo> #<n> · <recap link>` (first blocked issue).
- Choose buttons reappear automatically (already gated on `!threadLocked`).
- `resumed: false` → inline note "Saved — a run is already going; your note
  applies on the next resume." `resumed: true` → the existing SSE stream
  (`topic`/`issue` broadcasts + `fetchAll`) shows progress; no new wiring.
- "Resume realizing" button stays as the no-new-input fallback.

## Files

- `src/lib/board-ui.ts` (+ test): `isTopicThreadLocked(status, needsInput)`.
- `src/lib/realize.ts` (+ test): `shouldResumeOnReply`.
- `src/app/api/topics/[id]/messages/route.ts`: unlock branch + resume + additive
  `resumed` field.
- `src/app/api/topics/[id]/choose/route.ts`: unlock branch, skip summary
  rewrite when realizing, additive `resumed` field.
- `src/app/(board)/topics/[id]/page.tsx`: unlock rule, placeholder, target
  line, `resumed:false` note. No SSE changes.

## Verification (required)

- `typecheck → lint → test → build` per `AGENTS.md`.
- New unit tests: lock predicate matrix (6 statuses × needsInput), resume matrix
  (status × blocked × live), realizing-choose skips summary rewrite (via
  `shouldResumeOnReply` + route-level reasoning; routes themselves stay
  untested like today).
- Headless: seed a realizing topic with a blocked linked issue (e2e already
  seeds `developing + blocked_reason` issues; link one via
  `POST /api/issues/[id]/assign`), assert the reply box + Choose render,
  post a reply, assert `{ resumed: true }` and the loop restarts
  (`developing` without `blocked_reason`).
- Optional follow-up (not required): e2e S9 driving reply-to-resume end to end.

## Explicitly out of scope

- Mid-run (live, unblocked) replies — stay locked.
- Routing one answer to a *chosen* blocked issue when several block — goes to
  the resumed issue; named in the UI.
- Shaping flow, SSE schema, schema changes — none.
