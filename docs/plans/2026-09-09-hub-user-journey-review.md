# DevHub user-journey review (2026-09-09)

Base: `master` at `a911c8f` (`1.21.0`). Reviewed live with mocked GitHub
(22 issues, 3 projects) + code walk of `src/app/(board)`, `src/components/board`,
`src/lib/board-ui.ts`, `src/lib/transitions.ts`, `src/app/globals.css`.

## 1. Journeys

### 1.1 Sign in → home
- Files: `src/components/auth-ui.tsx`, `src/app/(board)/page.tsx`
- Good: `bumbleflies`-only gate message is explicit, `401` banners link to
  "log in again", SSE `live/connecting…` dot sets expectations.
- Friction: home is **projects-first** — no kanban at `/`, only under
  `/projects/[id]`. First-time users expecting a board see project cards +
  inbox + cockpit pill and may miss `Board →`.

### 1.2 Triage on project board
- Files: `projects/[id]/page.tsx`, `kanban-board.tsx`, `board-toolbar.tsx`
- Good: `backlog/refinement/developing/pr` + `RecentlyReleased/Closed` strips,
  repo chips, `repo:/title:/owner:/state:/body:/number:` search, per-column
  `newest/oldest`, blocked cards float to top with `Needs input`.
- Frictions:
  - `Refresh` on the project page `POST`s but doesn't `setIssues` — it relies
    on SSE, so it looks like nothing happened until a broadcast arrives.
  - Search on home jumps to project/recap links; on the project page it filters
    in place. Two mental models for one box.
  - Manual moves only `backlog ↔ refinement` (`src/lib/transitions.ts`).
    Correct, but invisible until you open `…` and fail.

### 1.3 Work flow (core loop)
- Files: `use-card-actions.ts`, `develop-modal.tsx`, `issue-card.tsx`
- Good: single `Work` entry, modal for extra instructions + model override,
  `202` + optimistic `justStarted` → SSE, failures stay in stage with
  `blocked_reason`, retry resumes. No dead `blocked` state.
- Frictions:
  - Batch `Work on selected` starts **immediately with defaults** — no
    instruction/model step, inconsistent with single-card Work.
  - Live copy is subtle: `working… (live via opencode)` vs
    `developing… <model>`. Easy to miss which run is yours.
  - `Advance selected` label lies for `refinement → backlog` (goes backwards).

### 1.4 Batch ops
- Good: checkboxes (desktop), `Select for batch` (mobile sheet),
  `Ctrl+A / Esc / Ctrl+Enter`, progress `working: n/m`.
- Frictions: shortcuts only exist on the project page, `Ctrl+A` hijacks a
  browser idiom, `Esc` also closes modals/sheets — selection clear can
  surprise. No bulk model/instruction override.

### 1.5 Recap `/issues/[id]`
- Best page in the app — breadcrumb project/topic, `Run timeline`, live pulse
  + model + snippet, `Needs input` markdown, `Done` PR/tag/`state_reason`,
  condensed agent digest, manual `Mark shipped`.
- Friction: `← Board` goes to `/`, not back to the project board you came from.

### 1.6 Ideas-first `/topics/[id]`
- Good: `So far` summary, options thread with one-click `Choose` +
  `Ctrl+Enter` reply, `Realize it / Resume`, `Mark ready / Archive / Merge
  into…`, timeline `Understanding → Building → Checking → Delivered`,
  `How it was built` hides execution well.
- **Bug-ish:** `threadLocked = dropped|shipped|realizing` hides the reply box
  during `realizing`, but the timeline note says "Answer above — work resumes
  on its own" when `needs-input`. If a realize blocks, the user can't answer
  in the thread — they're bounced to the project board.
- `Realize` confirm dialog for drafts is good; disabled `Realizing…` button
  gives no progress affordance beyond the timeline.

### 1.7 Cockpit freeform
- Files: `cockpit-composer.tsx`, `action-detail.tsx`, `action-status-strip.tsx`
- Good: `Enter` runs / `Shift+Enter` newline, prompt preserved on failure,
  strip + drawer with transcript/rerun/`Save as idea` on failure.
- Friction: trigger copy `Tell me what you want…` is vague next to a concrete
  `Work` button. No discovery of what cockpit can/can't do vs. per-issue Work.

### 1.8 Mobile
- Good: single-column + status-strip tabs, toolbar scrolls away, FAB + bottom
  sheet with keyboard inset, `…` sheet mirrors desktop actions.
- Friction: batch and search live behind icon/sheet triggers; repo filter only
  in the toolbar inside the scroll container — easy to never find.

## 2. UI: history steals focus from cards

Agreed — history currently gets equal weight to work:

- `KANBAN_COLUMNS = backlog / refinement / developing / pr`
  (`src/lib/board-ui.ts:148`). `.board` is
  `repeat(auto-fit, minmax(260px,1fr))`, so `pr` gets a full ~25% column with
  identical header/chrome as `backlog`. Same on mobile: 4 equal tabs.
- On home `/`, order is `ActionStatusStrip → RecentlyReleased →
  RecentlyClosed → ProjectsHome` (`page.tsx:483,537-538`). Two full-width
  history strips sit **above** the actionable cards.
- All strips share the same chrome:
  `background: var(--panel); border-bottom; min-height: 36px`
  (`.released-strip/.closed-strip/.action-strip`, `globals.css:716-816`).
  Nothing says "this is archive".

`pr` is borderline — it still needs review/merge — but `rollout/closed` are
pure history and shouldn't compete for first-screen pixels.

### Proposal (recommended)
1. Split **Now vs Done**: keep `backlog/refinement/developing` as the
   3-column kanban. Demote `pr + Released + Closed` into one collapsed `Done`
   rail/strip below the board, muted, collapsed by default (`+n more` like
   `released-strips.tsx` already does).
2. Move strips **below** `ProjectsHome` / board, never above. History should
   not push cards below the fold.
3. De-emphasize: smaller type, `color: var(--muted)`, desaturated dots, counts
   hidden until expanded. Mobile: `pr` tab behind `…` or badge-only.

Minimal first step: merge `Released + Closed + PR` into a single collapsed
`Done` section under the board.

## 3. Highest-value fixes (priority order)

1. Fix realize `needs-input` reply path — don't lock the thread when input is
   needed, or deep-link the exact issue/blocker.
2. Make project-board `Refresh` optimistically refetch; fix `← Board`/recap
   back-nav to return to the project.
3. Rename `Advance selected` (it toggles `backlog ↔ refinement`); give batch
   Work the same instruction/model modal as single Work.
4. Update `README.md` board description — still says 4 columns
   `backlog/developing/pr/blocked`; real columns are
   `backlog/refinement/developing/pr` + rollout/closed strips.
5. Add one empty-state hint on home: "pick a project → Board" for first-run.
6. Collapse history (section 2) so cards own the first screen.
