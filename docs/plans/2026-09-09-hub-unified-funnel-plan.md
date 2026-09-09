# Unified-funnel implementation plan (2026-09-09)

Design: `2026-09-09-hub-user-journey-redesign.md` + canvas
`docs/plans/assets/2026-09-09-hub-user-journey-canvas.html`
(artboards `Main / Board / Mobile / BoardAltPR / MobileAltFilter / BoardUnified`;
`BoardUnified` is the locked target).
Follows up: `2026-09-09-hub-user-journey-review.md` (same branch:
`docs/hub-user-journey-review`).

## Target

Project board draws ONE lane; the topic/issue seam never shows:

| Funnel column | Contents today | Card footer |
|---|---|---|
| **idea** | topics `new` + `shaping` | `Discuss →` (topic page), never `Work` |
| **ready** | topics `ready` + issues `backlog` | topic → auto-promoted issue; issue → `Work` |
| **realizing** | issues `refinement` + `developing` | validation note or live `developing…` line |
| **rollout** | issues `pr` + `rollout` | PR link / release tag; still live, needs human merge |
| **delivered** | issues `closed` (+ released) and topics `shipped`/`dropped` | muted, collapsed below the four live columns |

Kept: the data-model split (cheap topics vs GitHub-backed issues).
Changed: board mapping, auto-promotion on ready, history demotion.

## Phase 0 — funnel view-model (no behavior change)

- New `src/lib/funnel.ts` (+ `funnel.test.ts`):
  - `FunnelColumn = 'idea' | 'ready' | 'realizing' | 'rollout' | 'delivered'`.
  - `funnelColumnForTopic(status): 'idea' | 'ready' | 'delivered'`
    (`new|shaping → idea`, `ready|realizing → ready`, `shipped|dropped → delivered`).
    Note: `realizing` topics with no live issue (e.g. pre-promotion) read as
    `ready` — the issue list is the source of truth once linked (see Phase 2).
  - `funnelColumnForIssue(state): 'ready' | 'realizing' | 'rollout' | 'delivered'`
    (`backlog → ready`, `refinement|developing → realizing`,
    `pr|rollout → rollout`, `closed → delivered`).
- Acceptance: unit tests over all 6 `IssueState` × 6 `TopicStatus`; no imports
  of this module anywhere yet. Gate: `typecheck → lint → test`.

## Phase 1 — project board renders the funnel (frontend only)

Files: `src/app/(board)/projects/[id]/page.tsx`,
`src/components/board/kanban-board.tsx`,
`src/components/board/mobile-status-strip.tsx`,
`src/components/board/issue-card.tsx` (topic cards: new `topic-card.tsx`
or a light variant), `src/lib/board-ui.ts`.

- Replace `KANBAN_COLUMNS` with funnel columns on the project board only
  (keep `KANBAN_COLUMNS` export; home has no kanban).
- **Topics rail removed.** Ideas render as cards in the `idea` column from the
  already-fetched `topics` list (no new fetch). Card shows title, status chip
  (`New`/`Shaping`), `shapedSummary` excerpt, footer `Discuss →`
  (`/topics/[id]`). No checkbox, no `Work`, no batch membership.
- `ready` column mixes `ready` topics (with `→ issue` affordance until Phase 2
  lands, then auto) and `backlog` issues (full `IssueCard`, unchanged).
- `realizing` merges `refinement` + `developing` issues, same sort
  (blocked-first, then `sorts` toggle). Column position no longer encodes the
  sub-stage; the card body already distinguishes (validation note vs live line).
- `rollout` merges `pr` + `rollout` issues.
- **Delivered** is not a kanban column: collapsed muted section below the
  board (`closed` issues + `shipped`/`dropped` topics, capped at 5 + `+n more`,
  reusing the `released-strips.tsx` pattern). Muted type, desaturated dots,
  counts hidden until expanded.
- Search: issues keep `matchesIssue`; topics match title/notes/status
  (small `matchesTopic` helper next to it, tested). Repo chips filter issues;
  topics (no repo) always pass the repo filter. Counts per funnel column.
- Selection/batch unchanged in behavior; labels change (Phase 3).
- SSE: no new event types — existing `issue`/`topic`/`run` handlers already
  update both lists; funnel is a pure derivation, so it re-renders free.
- Mobile: status-strip tabs become the 4 live columns + badge-only `Done`;
  single-column rendering follows `activeColumn` as today.
- Acceptance: mocked-GitHub board shows the 5-zone layout; empty funnel
  columns render `nothing here`; topic cards link out; no `Work` on ideas.
  `headless-check.mjs --path /projects/<id>` passes.

## Phase 2 — auto-promotion on ready (behavior change)

Files: `src/app/api/topics/[id]/ready/route.ts`,
`src/app/api/topics/[id]/promote/route.ts` (extract shared helper),
`src/lib/store.ts` (`refreshTopicStatus`), `src/lib/realize.ts`
(`canRealize`), `src/lib/skills/promote-topic.ts` (reuse helper).

- Extract `promoteTopic(topic, token)` from the promote route (create GitHub
  issue → `upsertIssue` → `assignIssue({projectId, topicId})` → publish).
- `POST /api/topics/[id]/ready` calls it inline after marking `ready`:
  - `requireMember` already yields the token — use it (ready route currently
    discards it).
  - Preconditions: project with service repo, else `400` with the current
    "no service repo" copy; topic stays `ready`, UI surfaces retry.
  - Idempotency: if a linked issue already exists (`getIssues` by topic),
    skip creation and return it.
  - Failure (GitHub 502): topic stays `ready`, error returned; the manual
    `→ issue` button remains as retry until this proves reliable, then is
    removed.
- Topic-status semantics change (currently: any linked issue → `realizing`):
  - no issues → keep caller-set status (`ready`);
  - issues all in `backlog` → `ready`;
  - any `refinement|developing|pr|rollout` → `realizing`;
  - all `closed`/`rollout` settled → `shipped` (unchanged).
  - Update `refreshTopicStatus` + its callers' expectations; extend
    `store.test.ts` (the `shaping→ready` cases at `store.test.ts:434-435`
    stay green).
- `canRealize` interplay: `ready` + auto-created `backlog` issue must still
  resolve to `full` (already does per `realize.test.ts:77`); add a case for
  `ready` with zero issues (pre-promotion race) → treat as `full` after
  promotion, not an error.
- Acceptance: new route tests (ready creates exactly one issue; second call
  is idempotent; no-repo 400; GitHub failure keeps `ready`); full suite +
  `e2e-workflow.mjs` green.

## Phase 3 — home, mobile, batch labels, docs

- Home (`page.tsx`, `projects-home.tsx`, `released-strips.tsx`): first-run
  hint above the grid (`Pick one to open its board →`); merge
  `RecentlyReleased` + `RecentlyClosed` into one collapsed muted `Done` strip
  **below** the grid.
- Batch bar (`projects/[id]/page.tsx`): directional labels from selection
  composition — all-`backlog` → `Move to Refinement (n)`, all-`refinement` →
  `Move to Backlog (n)`, mixed → `Move (n)` with per-card direction unchanged.
- Mobile: repo-filter chips as a permanent row under the status tabs
  (canvas `Mobile` artboard); revisit the `MobileAltFilter` toggle only if
  vertical space regresses.
- `README.md`: replace the stale 4-column board description with the funnel.
- Acceptance: home first screen is projects, not history; batch label never
  says `Advance` for a backwards move.

## Phase 4 — verification

Order per `AGENTS.md`: `typecheck → lint → test → build`, then
`start-dev.mjs` + `headless-check.mjs` (home + `/projects/<id>`) +
`e2e-workflow.mjs`. Each phase lands separately; Phase 1 is safe to ship
without Phase 2 (manual `→ issue` still bridges).

## Explicitly out of scope

- Realize needs-input thread lock (redesign doc §"Not designed yet" §1) —
  structural fix (auto-promotion) removes one instance; the
  live-needs-input-while-realizing reply path needs its own design.
- `BoardAltPR` (narrow muted `pr` column) — superseded by `pr ⊂ rollout`.
- Schema changes — none; funnel is a view derivation + a ready-time side
  effect reusing existing tables.
