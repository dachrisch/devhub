# Unify develop flow + remove blocked state

> Status: implemented (2026-09-02). Resolves
> [dachrisch/devhub#132](https://github.com/dachrisch/devhub/issues/132).
> Supersedes the flow sections of `2026-08-30-devhub-design.md`.

## Goal

An issue flows through the system with clear stage goals and **no user
intervention**. When a stage can't proceed, the card **stays in its stage**
with a `blocked_reason` ("Needs input") banner; the user clicks **Work** again
and the card resumes from where it was.

**Card flow:** `backlog → refinement → developing → pr → rollout → closed`

**No `blocked` state.** A `blocked_reason` column marks the stage that needs
input. Batch operations collapse to a single "Work on selected" action.

## Validation of the issue plan (corrections applied here)

The plan embedded in issue #132 was checked against the code before
implementation. Three claims were wrong and five gaps were fixed:

1. `upsertIssue` had no `OR state = 'blocked'` clause to remove (its WHERE was
   already `state = 'backlog' OR state = 'closed'`); only a doc comment
   mentioned it.
2. `reconcileClosedIssues` had no blocked-label sync block; only
   `STATE_LABELS` and `RECONCILE_STATES` needed the `blocked` entry removed.
3. The issue's `notifyBlocked` snippet contained a stray `\` in the tag
   template.
4. **Double-run hazard:** making `developing` unconditionally developable
   would let "Work" spawn a second opencode session on a live run.
   Fixed: `developing` is developable **only when `blocked_reason` is set**
   (every failed/interrupted run ends with one; `recoverStuckDeveloping`
   stamps it after a restart).
5. **Stale body bug:** `runRefinement` must refetch the issue after writing
   `improvedBody`, or `startDevelop` prompts against the old body.
6. `setIssueBody` was referenced but never defined — added to the store.
7. The old validate path (`startValidation`, `POST /api/issues/[id]/validate`,
   batch `develop`/`validate` modes, the second modal button) is removed, not
   left dangling; this also breaks the develop↔validate circular import.
8. The recap feed now filters `refinement-event` like `validation-event`.
9. Notifications fire on a *newly-set* `blocked_reason` even when the state
   doesn't change (develop-stage failures), via a parallel `prevBlockedRef`.

## Stage goals

| Stage       | Goal                                   | Auto-transitions to                                  |
|-------------|----------------------------------------|------------------------------------------------------|
| `backlog`   | Waiting to be worked on                | `refinement` (Work)                                  |
| `refinement`| Check readiness, auto-refine if possible| `developing` (if ready / auto-refined)              |
| `developing`| Implement the change, open PR          | `pr` (PR opened) or `closed` (already resolved)      |
| `pr`        | PR open, waiting for merge + release   | `rollout` (merged + tag contains merge commit)       |
| `rollout`   | Released                               | `closed` (terminal)                                  |

Failure in any stage → `blocked_reason` set, state unchanged. Work click →
reason cleared, stage re-run.

## Implementation notes (by file)

- `src/lib/types.ts` — `IssueState` loses `'blocked'`; `Issue.blockedReason` /
  `IssueRow.blocked_reason` added; `serializeIssue` maps it.
- `src/lib/store.ts` — migration adds `blocked_reason` and re-admits legacy
  `state='blocked'` rows as `backlog` with
  `blocked_reason = 'Previous attempt: ' || result_text` (idempotent: nothing
  writes `blocked` again). New helpers `setBlockedReason`, `clearBlockedReason`,
  `setIssueBody`. `recoverStuckDeveloping` keeps state `developing` and sets
  the reason. `reopenIssue` also clears the reason.
- `src/lib/github.ts` — `updateIssueBody` (PATCH issue, 64 KiB clamp);
  `STATE_LABELS` / `RECONCILE_STATES` drop `blocked`.
- `src/lib/validate.ts` — `buildRefinePrompt` (JSON-output refinement prompt)
  + `parseRefineResult` (JSON with `READY:` fallback). `startValidation`
  deleted (removes the circular import with develop.ts).
- `src/lib/develop.ts` — `startWork` routes by stage (backlog → move to
  refinement + run refinement; refinement → re-check; developing → retry;
  later stages → no-op). `runRefinement` runs opencode, mirrors the result to
  GitHub (comments + body update), and proceeds to `startDevelop` **with the
  refetched issue**. `startDevelop` failure paths call `setBlockedReason` and
  stay in `developing`. `startStagedDevelop` deleted. `canDevelop` = backlog ∥
  refinement ∥ (developing ∧ blockedReason).
- `src/lib/skills/fix.ts` — failure paths use `setBlockedReason`.
- `src/lib/board-ui.ts` — `isWorkable` helper (mirrors `canDevelop`);
  `cardActions`/`primaryCardAction` take `Pick<Issue,'state'|'blockedReason'>`
  and emit the single `work` action; failed developing cards show "Work" +
  plain Recap, live ones "Recap (live)".
- Board UI (`src/app/(board)/page.tsx` + components) — four columns
  (backlog/refinement/developing/pr); one "Work" button per workable card;
  "Needs input" banner (`.card-blocked`); blocked cards sort to the top of
  their column; notification on new `blockedReason` or `pr`; batch UI has
  "Work on selected" + "Advance selected".
- API — `POST /api/issues/[id]/develop` always calls `startWork` (no `staged`
  param); `POST /api/issues/batch-advance` supports `mode:'work'`;
  `/api/issues/[id]/validate` deleted.
- Recap page — no blocked done-state; "Needs input" panel; refinement events
  labeled and `refinement-event` filtered from the digest.

## E2E testing (goal gate)

Harness: `scripts/dev/start-dev.mjs` now also starts
`scripts/dev/mock-opencode.mjs` (local http server; the app's
`OPENCODE_BASE_URL` points at it — necessary because `opencode.ts` uses
undici's fetch directly, so a global-fetch patch can't intercept it). The mock
classifies prompts ("You are refining" vs "You are implementing") and returns
scenario-controlled replies; the scenario is flipped mid-run via
`POST /__mock/scenario` (`refine: ready|improve|blocked`,
`develop: pr|cannot`). `scripts/dev/seed.mjs` seeds a failed-run fixture
(devhub#105: `developing` + `blocked_reason`).

`node scripts/dev/e2e-workflow.mjs --url http://localhost:<port>` drives
headless Chromium over CDP (localhost only — see the headless-dev skill) and
asserts both server truth (`GET /api/issues`) and DOM (cards, banners,
buttons, column heads), with screenshots to `.devhub-e2e/`:

| Scenario | Asserts |
|---|---|
| S1 happy path | backlog #101 → Work → `pr` with PR URL rendered; no blocked column |
| S1b auto-refine | refine:improve → `improvedBody` persisted to the DevHub row, then `pr` |
| S2 needs input | refine:blocked → card stays `refinement` with question banner; refine:ready + Work → `pr`, reason cleared |
| S3 develop retry | develop:cannot → card stays `developing` with banner + Work button; develop:pr + Work → `pr` |
| S4 batch work | two selected backlog cards → "Work on selected" → both `pr` |
| guard | column heads never include `blocked`, at startup and after runs |

Run: `node scripts/dev/start-dev.mjs --port 3111` (fresh `DEVHUB_DB`), then
`node scripts/dev/e2e-workflow.mjs --url http://localhost:3111`.

## Standard verification order

`npm run typecheck` → `npm run lint` → `npm test` → `npm run build` → e2e S1-S4.
