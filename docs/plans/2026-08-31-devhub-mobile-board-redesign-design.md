# DevHub Mobile Board — Visual Redesign

**Date**: 2026-08-31
**Source**: Claude Design project "Mobile layout improvements" —
`https://claude.ai/design/p/4895ccb1-35b3-4942-9db0-906a9f448b28`, canvas
`DevHub Mobile.dc.html`
**Status**: Design approved (2b card treatment picked over 2a)
**Supersedes (partially)**: `2026-08-30-devhub-mobile-layout-design.md` — that
pass fixed usability bugs (header clipping, hardcoded columns, undersold
touch targets) with the *existing* desktop card markup reused at a mobile
breakpoint. This round is a genuine visual redesign of the mobile board on
top of that already-shipped baseline, not a second bug-fix pass.

## Already shipped (baseline, do not re-implement)

Current `master` (`d2d79d8`) already has, from the prior design:
- `@media (max-width: 768px)` breakpoint throughout `src/app/globals.css`
- Fixed **bottom-nav** tab bar (one tab per column, dot + label + badge)
- Horizontal scroll-snap columns (`.board`/`.column`) with one column per
  screen, driven by `activeColumn` state + `IntersectionObserver` +
  `scrollToColumn()` in `src/app/(board)/page.tsx`
- 44px touch targets, wrapping header, hidden brand-name/auth-login text
- A `.search-help` popover (not the "expandable search" the old design doc
  sketched — that variant was never built; a simpler always-visible input +
  "?" popover shipped instead)

This redesign **replaces** the bottom-nav and the search popover on mobile,
and **replaces** the card markup on mobile. It does not touch desktop layout
or any server-side behavior.

## Canvas contents

The canvas is one long page with two labeled turns:

- **Turn 2** (top of canvas, `#2a`/`#2b`) — two alternative card treatments,
  explored side by side:
  - **2a "Scan rows"**: no card chrome, no excerpt. One 44px row per issue:
    title (2-line clamp) + one meta line (`repo · #number · age`), a colored
    left border for repo identity, inline Develop + overflow-dots per row.
    Optimizes for density (5 issues visible instead of 3). **Not adopted.**
  - **2b "State strip"**: keeps card chrome, but moves repo identity to a
    full-width tinted header strip (drops the left-border rule and repo
    pill), and the footer becomes a split action bar: a wide primary button
    + a 64px overflow button, both 48px tall. **Adopted** — the canvas's own
    annotation on the Turn-1 screens reads "full flow, now on 2b cards".
- **Turn 1** (`#1a`, below) — the full flow, already updated to use 2b cards:
  **Board**, **Card actions** (bottom sheet), **Developing** (live state),
  **Search** (full-screen sheet).

## Screens and what they specify

### Board
- Header: logo + search field (tap-target, not a live-typing input on this
  screen) + a 3-dot overflow icon. Live status, refresh, repo filters and
  sign-out move behind that overflow icon and the search sheet.
- Sticky status strip directly under the header: one horizontally-scrollable
  tab per column (dot + label + count), replacing the bottom-nav. Tapping a
  tab is the same "scroll the swipeable board to that column" action the
  bottom-nav already performs today — only the chrome moves from the bottom
  to the top.
- A slim meta row per column: `"{N} issues · {M} repos"` + the existing
  sort-toggle (`↓ newest` / `↑ oldest`). This replaces today's column-head
  (`● backlog (21)`), whose column-name+count job the status strip now does.
- Cards: 2b treatment — tinted header strip (repo color, `#number`, age),
  title (3-line clamp) + excerpt (2-line clamp), footer split into one
  primary action (flex, 48px) + a 64px "..." overflow button.

### Card actions (bottom sheet)
Tapping a card's overflow button opens a sheet: issue ref + title, then
action rows (52px each) — **Develop (with validation)**, **Move to
refinement**, **Recap**, **Select for batch**, **Open on GitHub** (offset by
a divider). This sheet is what replaces the four separate inline buttons +
persistent checkbox the desktop card shows today.

### Developing
Same card, `developing` state: the tab strip shows a pulsing dot on the
active `developing` tab; the card gets an inline pulsing-dot status line
(mockup text: `"developing… 4m elapsed"`) and its primary footer button
becomes `"Recap (live)"` instead of `"Develop"`.

**Known gap**: elapsed-time-in-card requires new data (`Issue` has no
started-at timestamp today) — **out of scope for this round**, ship the
existing static copy (`"developing… (live via opencode)"`) in the pill
instead of a live counter.

### Search
Tapping the header search opens a full-screen sheet: repo filter chips (All
+ one per repo, colored dot), a static legend of the filter syntax
(`repo: title: owner: state: body: number:`, already supported by
`matchesIssue` in `page.tsx`), and a live, scrollable match list.

## Explicitly deferred (not in the implementation plan)

- **2a "scan rows" card style** — kept as a documented alternative on the
  canvas only; not built. No user-facing toggle between 2a/2b.
- **Header overflow menu** (3-dot icon consolidating live status, refresh,
  repo filters, sign-out) — the mockups show the icon but never its expanded
  state, so its contents/order aren't actually specified. The existing
  mobile header (icon buttons, hidden brand/username text) stays as is.
- **`density` (medium/compact) and `showTabCounts` props** baked into the
  canvas's `<script data-dc-script>` — these are Claude-Design-canvas
  preview toggles (for exploring the design in the tool), not a requested
  end-user setting. The real board always shows the excerpt and always
  shows tab counts; no settings UI is added.
- Moving the existing `RecentlyReleased` strip to be per-column (the
  Developing screen shows a released item near the live card, but nothing
  in the canvas commentary asks for restructuring where it renders) — it
  stays a single global strip above the toolbar, unchanged.

## Design tokens

The canvas's inline hex values are the *same* palette already in
`src/app/globals.css`'s `:root` (`--bg #0d1117`, `--panel-2 #1c2230`,
`--border #30363d`, `--text #e6edf3`, `--muted #8b949e`, `--accent #58a6ff`,
plus one custom property per issue state). The implementation must reuse
those custom properties, not the mockup's hardcoded hex — the canvas's own
Turn-2 commentary says as much ("both stay on the tokens from globals.css").

## Imported scaffold files (read, not ported)

- `ios-frame.jsx` — a Claude-Design "omelette starter" iPhone bezel
  component (`@ds-adherence-ignore`, "Copied omelette starter"). Presentation
  chrome for the design tool only; has no counterpart in the real app.
- `support.js` — generated `dc-runtime` (`// GENERATED from dc-runtime/src/*.ts
  — do not edit`), the engine that parses `<x-dc>`/`<x-import>`/`<sc-if>` in
  the canvas format. Confirms how to read the canvas's template syntax; not
  application code.
- `public/logo.png` — the same asset already at `devhub/public/logo.png`
  (used today via `src/components/logo.tsx`). No new asset work needed.
