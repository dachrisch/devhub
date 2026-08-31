# DevHub Mobile Board Redesign — Status

**Date**: 2026-08-31 (updated after Task 5-7 completion)
**Branch**: `feat/mobile-board-redesign`
**Spec**: `docs/plans/2026-08-31-devhub-mobile-board-redesign-design.md`
**Plan**: `docs/plans/2026-08-31-devhub-mobile-board-redesign-plan.md`
**Execution**: subagent-driven-development (fresh implementer + task reviewer
per task, in-session), working directly on `master` at the user's explicit
choice (no isolated worktree).

The original run was stopped mid-fix-loop by explicit user request ("stop
here, push everything we have to a draft PR"), triggered by a dispatched
fix subagent hitting the session's monthly spend limit (HTTP 429) partway
through Task 3+4's Critical-finding fix. Work resumed in a follow-up
session on `feat/mobile-board-redesign`: the Critical + Minor bugs were
fixed, Tasks 5-7 were completed, and the whole branch was reviewed.
**The one remaining gap is browser-based manual verification, which this
headless environment could not run — see "Remaining verification" below.**

## Done

### Task 1 — `src/lib/board-ui.ts` extraction
Commit `43e04a2`. Pure display/decision logic (`repoColor`, `matchesIssue`,
`relTime`, `excerpt`, `countRepos`, `cardActions`, `primaryCardAction`)
moved out of `page.tsx` into a new, unit-tested `src/lib/board-ui.ts`
(16 new tests, `environment: 'node'`, no rendering/mocks). `ModelOption`
moved to `src/lib/types.ts`. Task review: **Approved**, 0 Critical/Important
findings, 1 Minor (a typo in the plan doc itself — "8 describe blocks" vs.
actual 7 — not a code defect).

### Task 2 — `useCardActions` hook + `DevelopModal` component
Commit `0fcb22f`. Desktop `Card`'s inline develop/transition state and
callbacks extracted into `src/components/board/use-card-actions.ts`; its
inline modal + private `ModelPicker` extracted into
`src/components/board/develop-modal.tsx`. Pure refactor — desktop `Card`
now consumes both, behavior unchanged. Task review: **Approved**, 0
Critical/Important findings (reviewer specifically verified the
`develop`/`stagedDevelop` request-body distinction — the most likely place
for this kind of extraction to silently break — and confirmed it's intact).

### Tasks 3+4 — mobile card + card-actions sheet (dispatched combined,
since Task 3 has no independent commit per the plan's own text)
Commit `e9284b9`. Adds `src/components/board/use-media-query.ts`
(`useMediaQuery`/`MOBILE_QUERY` at `768px`, matching the existing CSS
breakpoint), `src/components/board/mobile-card.tsx` (2b card treatment:
tinted header strip, title/excerpt, developing-status pill, split footer),
`src/components/board/card-actions-sheet.tsx` (bottom-sheet menu driven by
`cardActions()`), new CSS in `globals.css`, and `page.tsx` wiring
(`isMobile` branch in the card list, `MobileCardWithActions` +
`CardActionsSheetWithActions` wrapper components, `openActionsFor` state).

**Task review found 1 Critical + 1 Minor. Both are now fixed** (commit
`4399743`, resumed session) — see below.

## Known bug — fixed (was Critical)

**"Develop (with validation)" never opened the modal on mobile.**

`src/components/board/card-actions-sheet.tsx`'s row `onClick` originally
did `onSelect(action.id); onClose();` synchronously for every action. In
`src/app/(board)/page.tsx`, `CardActionsSheetWithActions`'s
`handleSelect('develop-validated')` called `openModal()` (local
`modalOpen = true`), and the row's own handler then immediately also called
the passed-down `onClose` — which is `() => setOpenActionsFor(null)` in
`BoardPage`. `BoardPage` renders `CardActionsSheetWithActions` itself gated
on `openActionsFor && isMobile`, so clearing `openActionsFor` unmounts
`CardActionsSheetWithActions` in the same batched render — the render
where `modalOpen` would show `DevelopModal` never commits with the
component still mounted. **Net effect: tapping "Develop (with validation)"
on mobile silently did nothing.**

The pattern came from the plan document's own Task 4 code (not an
implementer deviation) — logged as a ruling in the SDD ledger
(`.superpowers/sdd/2026-08-31-devhub-mobile-board-redesign-plan/progress.md`,
git-ignored, not in this PR).

### The fix (applied in commit `4399743`)

1. **`src/components/board/card-actions-sheet.tsx`**: the button row's
   `onClick` is now just `onSelect(action.id)` — the sheet no longer
   auto-closes on select. The `recap` row's `<Link ... onClick={onClose}>`
   is unchanged (normal navigate-and-dismiss).
2. **`src/app/(board)/page.tsx`'s `CardActionsSheetWithActions`** now owns
   closing per action:
   - `'develop-validated'` → `openModal(); return;` only. Does **not** call
     `onClose()` — the component stays mounted so `modalOpen` persists.
   - `'to-refinement'` / `'to-backlog'` / `'select-batch'` / `'open-github'`
     → dispatch, then `onClose()`.
   - Render is mutually exclusive: `if (modalOpen)` renders `DevelopModal`
     (with `onCancel={onClose}`,
     `onDevelop={() => { void develop(); onClose(); }}`,
     `onStagedDevelop={() => { void stagedDevelop(); onClose(); }}`),
     otherwise the sheet. The sheet is no longer in the DOM while the modal
     is open, which also removes the z-index stacking concern
     (`.card-sheet-backdrop` 200 vs `.modal-overlay` ~50) for free.
3. Verified: `npm run typecheck && npm run lint && npm test && npm run build`
   all PASS.

## Known bug — fixed (was Minor)

`.card-sheet-row:first-of-type`'s CSS suppressed the top border
independently per HTML tag (`<button>` vs. the `<a>` recap row), not per
visual position — exactly one row missed its divider in every board state.
Fixed by dropping `:first-of-type` and applying an explicit
`card-sheet-row-first` class to the first mapped row (same commit), and
the divider now renders for all but the first row in every state.

## Not started

**All originally-pending tasks are now complete in the resumed session:**

- **Task 5** — sticky top status strip (`MobileStatusStrip`), replacing the
  fixed bottom-nav; per-column meta row (`{N} issues · {M} repos` + sort
  toggle) replacing the desktop-style column-head on mobile. Commit
  `72c439b`. Also dropped the bottom-nav's now-dead 56px `.board`
  padding-bottom (16px) and removed the `.bottom-nav*` CSS block.
- **Task 6** — full-screen search sheet (`MobileSearchSheet`), replacing
  the `.search-help` popover on mobile. Commit `933827c`.
- **Task 7** — docs done: `README.md` project-layout row added
  (commit `474c2ef`). `npm run typecheck && npm run lint && npm test &&
  npm run build` all PASS. Browser-based manual verification was **not**
  run (headless environment) — see "Remaining verification" below.
- The final whole-branch review ran in-session against the full
  `d2d79d8..HEAD` diff: all 4 new components, the `page.tsx` rewiring, the
  `useMediaQuery` rewrite, and the shared hook/modal/extracted-logic layers
  were re-read and traced through each issue state; no new findings.

## Remaining verification (manual, needs a browser)

The one open item before merge is a real-browser pass at a <768px viewport
(and a desktop regression pass), since this environment has no browser
tooling. Concretely:

- Below 768px, for an issue in each of `backlog`, `refinement`,
  `developing`, `pr`, `blocked`:
  - card renders (tinted strip, title/excerpt, correct primary footer
    button per `primaryCardAction()`);
  - the actions sheet lists exactly the rows `cardActions()` specifies;
  - **"Develop (with validation)" opens the modal** (this PR's former
    Critical bug) and Cancel/Start/Validate-and-Develop each exit cleanly;
  - "Move to refinement"/"Move to backlog"/"Select for batch"/"Open on
    GitHub" dispatch and close the sheet;
  - status strip counts match the cards per column and tapping a tab
    scrolls the board;
  - the header search opens the full-screen sheet and live-filters.
- Desktop (≥768px) regression: cards, batch selection, keyboard
  shortcuts, model picker, and the search input + "?" popover are
  pixel-for-pixel unchanged.
- `useMediaQuery` was rewritten from a `useState`+`useEffect` pair to
  `useSyncExternalStore` (to satisfy the `react-hooks/set-state-in-effect`
  lint rule, which is live now that the eslint-config-next install issue
  below is resolved). The hydration path is the same as before
  (server renders `false`, client updates after mount), but worth a quick
  confirm that the board doesn't flash at a mobile width.

## Environment notes for whoever picks this up

- **`npm run lint` now passes (0 errors) on this branch.** The original
  run failed repo-wide because the installed `eslint-config-next@15.5.24`
  had no `exports` map (Node ESM couldn't resolve the
  `eslint-config-next/core-web-vitals` subpath); the dependency install
  has since been fixed externally, and the only remaining lint output is a
  pre-existing warning in `src/components/use-auth.ts`, untouched by this
  PR. `npm run typecheck && npm run lint && npm test && npm run build`
  are all green.
- **This checkout (`/home/cda/dev/devhub`) is shared, not an isolated
  worktree** (the user explicitly chose to work in place). While this
  branch's work was in progress, unrelated files appeared in the working
  tree from what looks like a different, concurrent effort — an untracked
  `.opencode/plans/2026-08-31-devhub-cockpit-implementation.md` and
  `docs/plans/2026-08-31-devhub-cockpit-design.md` (a "DevHub Cockpit —
  Orchestrator Design" proposal, unrelated to the mobile board), plus
  unstaged modifications to `next-env.d.ts` and `tsconfig.json` (the
  latter reverting `"jsx": "react-jsx"` to `"jsx": "preserve"` — not a
  change this plan's tasks made or need). **None of that is included in
  this branch or PR.** If those files matter, they need their own review
  from whoever is doing that work.
- A pre-existing untracked `CLAUDE.md` (repo guidance, written earlier in
  this session, unrelated to the mobile redesign) and a pre-existing
  untracked `docs/plans/2026-08-31-recover-stuck-developing.md` (leftover
  from the already-merged PR #78) were also left out of this branch —
  neither belongs to this feature's scope.

## Resuming this work

1. Run the remaining browser verification listed under "Remaining
   verification" above (a <768px pass across all issue states + desktop
   regression), then merge.
2. The `npm run lint` note below is now historical: the eslint-config-next
   `exports` install issue was resolved externally, and `npm run lint`
   passes (0 errors) on this branch — the sole remaining warning is
   pre-existing in `src/components/use-auth.ts` and untouched by this PR.
