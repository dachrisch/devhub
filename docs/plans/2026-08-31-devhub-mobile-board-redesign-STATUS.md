# DevHub Mobile Board Redesign — Status

**Date**: 2026-08-31
**Branch**: `feat/mobile-board-redesign`
**Spec**: `docs/plans/2026-08-31-devhub-mobile-board-redesign-design.md`
**Plan**: `docs/plans/2026-08-31-devhub-mobile-board-redesign-plan.md`
**Execution**: subagent-driven-development (fresh implementer + task reviewer
per task, in-session), working directly on `master` at the user's explicit
choice (no isolated worktree).

Execution was stopped mid-fix-loop by explicit user request ("stop here,
push everything we have to a draft PR"), triggered by a dispatched fix
subagent hitting the session's monthly spend limit (HTTP 429) partway
through Task 3+4's Critical-finding fix. **This PR is not mergeable as-is —
see "Known bug, not yet fixed" below.**

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

**Task review found 1 Critical + 1 Minor. Neither is fixed yet.**

## Known bug, not yet fixed (Critical)

**"Develop (with validation)" never opens the modal on mobile.**

`src/components/board/card-actions-sheet.tsx`'s row `onClick` currently
does `onSelect(action.id); onClose();` synchronously for every action. In
`src/app/(board)/page.tsx`, `CardActionsSheetWithActions`'s
`handleSelect('develop-validated')` calls `openModal()` (local
`modalOpen = true`), and the row's own handler then immediately also calls
the passed-down `onClose` — which is `() => setOpenActionsFor(null)` in
`BoardPage`. `BoardPage` renders `CardActionsSheetWithActions` itself gated
on `openActionsFor && isMobile`, so clearing `openActionsFor` unmounts
`CardActionsSheetWithActions` in the same batched render — the render
where `modalOpen` would show `DevelopModal` never commits with the
component still mounted. **Net effect: tapping "Develop (with validation)"
on mobile silently does nothing.** This is one of the two explicitly
required mobile develop flows in the plan's own Task 4 manual-verification
checklist.

This pattern came from the plan document's own Task 4 code (not an
implementer deviation) — logged as a ruling in the SDD ledger
(`.superpowers/sdd/2026-08-31-devhub-mobile-board-redesign-plan/progress.md`,
git-ignored, not in this PR) before a fix was dispatched.

### The fix (designed, not yet applied — do this first)

1. **`src/components/board/card-actions-sheet.tsx`**: stop auto-closing on
   select. Change the button row's `onClick` from
   `onClick={() => { onSelect(action.id); onClose(); }}` to just
   `onClick={() => onSelect(action.id)}`. Leave the `recap` row's
   `<Link ... onClick={onClose}>` as-is (normal navigate-and-dismiss,
   unaffected).
2. **`src/app/(board)/page.tsx`'s `CardActionsSheetWithActions`**: make it
   decide per-action whether to call the outer `onClose`:
   - `'develop-validated'` → `openModal();` only. Do **not** call
     `onClose()` — the component must stay mounted so `modalOpen` persists.
   - `'to-refinement'` / `'to-backlog'` / `'select-batch'` / `'open-github'`
     → keep the existing effect, and now explicitly call `onClose()` right
     after (the sheet no longer does this for them).
   - Render becomes mutually exclusive: `{!modalOpen && <CardActionsSheet
     issue={issue} onClose={onClose} onSelect={handleSelect} />}` /
     `{modalOpen && <DevelopModal ... />}` instead of always rendering the
     sheet and conditionally overlaying the modal.
   - `DevelopModal`'s three exit callbacks on this dispatcher become
     `onCancel={onClose}`, `onDevelop={() => { void develop(); onClose(); }}`,
     `onStagedDevelop={() => { void stagedDevelop(); onClose(); }}` — each
     fully unmounts the dispatcher via the outer `onClose`, matching the
     "dispatch, then optimistically close" pattern the other sheet actions
     already use.
   - This also resolves a secondary z-index concern the reviewer flagged
     (`.card-sheet-backdrop` at `z-index: 200` vs. `.modal-overlay` at
     `z-index: ~50`) for free: the sheet is no longer in the DOM at all
     while the modal is open, so nothing stacks incorrectly.
3. Verify: `npm run typecheck && npm test && npm run build` (skip
   `npm run lint` — see below), then manually trace or browser-test the
   click → state → render sequence.

## Known bug, not yet fixed (Minor, deferred)

`.card-sheet-row:first-of-type`'s CSS (in the Task 4 CSS block, already
in `globals.css` on this branch) suppresses the top border independently
per HTML tag (`<button>` vs. the one `<a>` for `recap`), not per visual
position. Result: exactly one row in the sheet is missing its top divider,
in **every** reachable board state (`backlog`/`refinement`/`developing`/
`pr`/`blocked`) — not just the 2 states the implementer's self-review
initially estimated; the task reviewer traced all five and confirmed it's
5-for-5. Purely cosmetic (a single missing 1px border), no functional or
layout impact. Deferred to the final whole-branch review's minor-findings
triage per the SDD process (`superpowers:subagent-driven-development`) —
not blocking, but worth fixing alongside the Critical bug above since
they're in the same file.

## Not started

- **Task 5** — sticky top status strip (`MobileStatusStrip`), replacing the
  existing fixed bottom-nav; per-column meta row (`{N} issues · {M} repos`
  + sort toggle) replacing the desktop-style column-head on mobile.
- **Task 6** — full-screen search sheet (`MobileSearchSheet`), replacing
  the small `.search-help` popover on mobile.
- **Task 7** — end-to-end manual verification across every issue state at
  `<768px`, desktop regression pass, `README.md` project-layout doc update.
- The final whole-branch code review (dispatched only after all 7 tasks are
  done, per the SDD process) has not run.

## Environment notes for whoever picks this up

- **`npm run lint` fails on `master` independent of any of this work** —
  the installed `eslint-config-next@15.5.24` package has no `exports` map
  in its `package.json`, so Node ESM can't resolve the
  `eslint-config-next/core-web-vitals` subpath `eslint.config.mjs` imports.
  Verified present before any commit in this branch. Out of scope for this
  feature; `npm run typecheck && npm test && npm run build` are the working
  gates until someone fixes the dependency install separately.
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

1. Fix the Critical bug above first (design is fully specified — it's a
   ~20-line change across the two files named).
2. Fix the Minor CSS divider issue in the same pass if convenient.
3. Continue with Tasks 5, 6, 7 from `docs/plans/2026-08-31-devhub-mobile-board-redesign-plan.md`.
4. Run the final whole-branch review before merging (per
   `superpowers:subagent-driven-development`'s process — dispatch on the
   most capable available model, pointing it at this status doc's
   known-issues list).
