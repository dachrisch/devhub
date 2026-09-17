# UI consistency: header, status, topic/issue duplication & layout (2026-09-17)

Design: this document + canvas https://claude.ai/artifact/EEur4ayucDZRFeUhUNLt1c
(artboards: `Main` — unified header + status legend; `Issue-Before`/`Issue-After`;
`Idea-Before`/`Idea-After`; `Detail-Shell-Before`/`Detail-Shell-After`;
`Delivered-Mobile`; `Cockpit-Strips`).

## Context

A design review of 5 screenshots (cockpit `/`, board `/projects/[id]`, issue
detail `/issues/[id]`, idea detail `/topics/[id]`) found two classes of
problem: (1) each page has visibly different header chrome, and (2) the same
idea title repeats 2–5 times across the issue and idea detail pages. Two
further passes over the running app surfaced a matching layout mismatch
between the two detail-page shells, and inconsistent mobile/desktop treatment
of the cockpit's and each board's "delivered/closed" lanes.

All of the below is confirmed in source, not just visually:

- **No shared header component exists.** `src/app/layout.tsx` is a bare
  shell. Three pages (`(board)/page.tsx:373-448`,
  `projects/[id]/page.tsx:546-599`, `topics/[id]/page.tsx:332-353`) each
  hand-roll their own copy of the same `<header className="app-head"><div
  className="brand">…` markup (with small unintentional divergences —
  `topics/[id]/page.tsx:338` hardcodes the literal text `"Idea"` instead of
  any real entity name, and uses `router.back()` instead of a `Link`). The
  4th, `issues/[id]/page.tsx:202-211`, uses an entirely different, unstyled
  `<header className="recap-head">` with no logo/brand/avatar at all —
  `.recap-head` (globals.css:1757-1762) has no padding or border, unlike
  `.app-head`'s inherited `header` rule (globals.css:81-87), which is why
  that page visually reads as headerless.
- **Three unrelated status vocabularies are shown as if interchangeable.**
  The issue page's header prints the raw `IssueState` enum, CSS-capitalized
  (`issues/[id]/page.tsx:205`, `.recap-state{text-transform:capitalize}`) —
  e.g. literally "Backlog". The board's kanban columns use a different,
  derived `FunnelColumn` vocabulary (`src/lib/funnel.ts`) where
  `funnelColumnForIssue('backlog')` returns `'ready'` (funnel.ts:60-73) — so
  that same issue sits in the board's "Ready" column while its own detail
  page says "Backlog", with nothing visually connecting the two. The idea
  page uses a third vocabulary, `TopicStatus` → `TOPIC_STATUS_LABELS`
  (types.ts:121-128), via yet another pill class (`.topic-status`,
  globals.css:3156-3182) that duplicates (rather than shares)
  `.proj-badge`'s near-identical CSS (globals.css:3007-3030).
- **The idea's title and the issue's title are the same string by one-time
  copy, then re-displayed with no de-dup.** `promoteTopicToIssue`
  (`src/lib/promote.ts:62`) copies `topic.title` into the new issue's own
  `title` column once, at realize time — there's no ongoing sync after that
  (`src/lib/store.ts:389-403`). Because of this, the issue detail page shows
  that title once in its own heading (`issues/[id]/page.tsx:213-217`) and a
  second time in its breadcrumb, which independently re-fetches the topic
  just to redisplay its title (`issues/[id]/page.tsx:112-121, 219-236`). The
  idea detail page's "How it was built" list then repeats it a further time
  per linked issue (`topics/[id]/page.tsx:585-598`), alongside 6 other places
  in the codebase that hand-compose the same
  `"{owner}/{repo} #{number}: {title}"` string independently with no shared
  formatter.

The existing dark palette (`:root` tokens, globals.css:1-16 — `--bg:#0d1117`,
`--panel:#161b22`, etc.) deliberately mirrors GitHub's own dark theme, which
fits this tool's job of managing GitHub issues alongside GitHub itself, and
it's applied consistently already (no competing hex values found). **This
plan does not change the palette or invent a new visual identity** — the
actual, evidence-backed pain is structural: inconsistent header chrome, a
3-way status mismatch, un-reconciled duplicate text, a mismatched detail-page
shell, and inconsistent mobile/desktop treatment of the delivered/closed
lanes. The fix is a shared-component + de-duplication pass within the
existing token system.

**Guiding principle for de-duplication:** only repeat information when it has
diverged or adds new meaning; otherwise show the *relationship* (a
link/label) without re-printing the same text. E.g., once an issue's title
still matches its parent idea's title, a "from idea" reference identifies the
relationship without reprinting the title; the full title only reappears when
it has diverged, or a list needs to disambiguate multiple linked issues.

## Approach

### 0. Visual mockup artifact (published — see canvas link above)

The canvas shows, as static HTML (no live data, sign-off on direction only):

- The one `AppHeader` layout in its 4 contextual states side by side:
  cockpit (no back button), board (back + project name + health pill), idea
  detail (back + project name + funnel-status pill), issue detail (back +
  `owner/repo #number` chip + funnel-status pill) — same header height,
  spacing, and back-button placement across all 4.
- The single `StatusPill` style with its funnel-derived tones
  (idea/ready/realizing/rollout/delivered) as a legend, and inline in each
  header state — demonstrating the issue detail page's pill now reads
  "Ready" (matching the board column) instead of "Backlog".
- Before/after of the issue detail page's title + breadcrumb (today: title
  repeats a second time in the breadcrumb → after: breadcrumb reads "Idea"
  when titles match, full title only when diverged) and the idea page's "How
  it was built" row (today: repeats the topic's own `<h1>` title → after:
  shows just `owner/repo #number` + status pill when there's one
  matching-title issue).
- Before/after of the detail-page shell width/panel/label mismatch (§0.5).
- Before/after of the delivered/closed lane's mobile wrap behavior and the
  cockpit's desktop strip consolidation (§0.6).

### 0.5. Shared detail-page shell

`.recap-wrap` (issue detail, globals.css:1751-1755) uses `max-width: 820px`;
`.topic-detail` (idea detail, globals.css:3134-3141) uses `max-width: 720px`.
These are the two halves of one work-item continuum but read as different
products because of this, plus two further mismatches:

- **Panel style:** the issue page's content panels (`.recap-live`/
  `.recap-result`, globals.css:1783-1820) use 14px padding and a 3px colored
  left-accent border that encodes outcome (green for PR, cyan for rollout,
  red for blocked, gray for closed). The idea page's summary panel
  (`.topic-detail-summary`, globals.css:3192-3200) uses 12px padding and no
  accent at all.
- **Section-label size:** `.recap-feed-head` ("Agent activity",
  globals.css:1926-1932) is 13px; `.released-label` ("So far",
  globals.css:829-835) and `.topic-msg-role` (message-role tags,
  globals.css:3248-3253) are 11px — same uppercase-muted-letterspaced
  treatment, inconsistent size.

Fix: one shared content-column width (760px — splits the difference and
stays under the 80-character line-length guideline) used by both
`.recap-wrap` and `.topic-detail`. Standardize section-panel padding at
14px/10px-radius with no accent by default, keeping the 3px colored
left-accent strictly for outcome/result panels on either page. Standardize
section-label size at 12px across `.recap-feed-head`, `.released-label`, and
`.topic-msg-role`.

### 0.6. Cockpit & closed/delivered lanes — desktop and mobile

**Mobile: the "delivered" pill list only got its mobile fix in one of its
three uses.** `.released-item`/`.released-list` (globals.css:837-896) is one
shared component — a rounded pill (`min-height: 44px`, `max-width: 360px`,
`white-space: nowrap`, ellipsis) inside a horizontally-scrolling flex row —
reused by three surfaces: the cockpit's cross-project Delivered ticker, each
project board's own Delivered ticker (both via `DeliveredSection`,
`src/components/board/delivered-section.tsx`), and the idea page's "How it
was built" list (`topics/[id]/page.tsx:585-598`). Only one consumer, global
search, has a mobile override:
`.global-search-results .released-item { flex-wrap: wrap; }` inside
`@media (max-width: 640px)` (globals.css:3689-3701). On a ~375–390px phone, a
360px-wide pill nearly fills the whole screen, so the other two surfaces
show one item at a time behind a blind horizontal swipe, with only a 28px
fade gradient (`.released-list::after`, globals.css:846-856) hinting there's
more.

Fix: extend `flex-wrap: wrap` to `.delivered-section .released-list` and
`.topic-how .released-list` at the same `640px` breakpoint.

**Desktop: three independently-declared "strip" blocks for one pattern.**
`.action-strip` (globals.css:910-918, the cockpit's live "create issue in
devhub…" row) and `.delivered-section` (globals.css:776-785) redeclare the
same recipe — flex row, ~10px gap, 24px side padding, 36px min-height, pill
children — independently, mixing accidental drift (border-top vs.
border-bottom, panel vs. page background) in with the one difference that's
actually meaningful (live items sit brighter/full-opacity; delivered history
sits dimmed at `opacity: 0.75`). A third pair, `.released-strip`/
`.closed-strip` (globals.css:818-827), is dead CSS — no `.tsx` file
references either class.

Fix: consolidate into one shared `.strip` base plus two modifiers
(`.strip--live`, `.strip--muted`); delete `.released-strip`/`.closed-strip`.
Add a small trailing "›" affordance next to the existing fade gradient for
long tickers (the cockpit's cross-project Delivered row can hold dozens of
items), since a 28px gradient alone is an easy-to-miss scroll hint with a
mouse cursor.

### 1. Shared `AppHeader` component — `src/components/app-header.tsx` (new)

One component, adopted identically by all 4 pages, following this repo's
existing shared-component convention (typed props interface, slot props for
page-specific content — see `KanbanBoard`'s `columnExtras`, `TopicCard`'s
`footerExtra`):

```ts
interface AppHeaderProps {
  back?: { href: string; label?: string };   // omitted on cockpit
  title: React.ReactNode;                     // "DevHub" | project name | <IssueRef variant="chip"/>
  status?: React.ReactNode;                   // <StatusPill/> — project health or funnel-derived tone
  connection?: { connected: boolean };
  controls?: React.ReactNode;                 // search box / refresh / batch actions
  user?: { login: string; avatarUrl: string | null; onLogout: () => void };
}
```

Body reuses the exact existing DOM shape (`header.app-head > div.brand +
div.head-controls`) so no CSS restructuring is needed beyond deleting the
issue page's divergent classes — it's a straight extraction of what 3 pages
already duplicate, made available to the 4th.

Per-page `title`/`status`/`back` values (this is also where the "Idea"
hardcode and the duplicate-title problem get fixed at the header level):

| Page | `back` | `title` | `status` |
|---|---|---|---|
| Cockpit (`(board)/page.tsx`) | none | `"DevHub"` | none |
| Board (`projects/[id]/page.tsx`) | `{ href: '/', label: 'Back to projects' }` | `project.name` | project health pill |
| Idea detail (`topics/[id]/page.tsx`) | `{ href: project ? '/projects/'+project.id : '/' }` | `project?.name ?? 'Inbox'` (replaces the hardcoded `"Idea"`) | funnel-derived topic status pill, **moved out of the body** (was `topics/[id]/page.tsx:369-371`) |
| Issue detail (`issues/[id]/page.tsx`) | `{ href: '/', label: 'Back to board' }` | `<IssueRef issue={issue} variant="chip"/>` (owner/repo #number only — the full title stays in the page's own `<h1>`) | funnel-derived issue status pill (replaces raw `issue.state` text) |

Adoption requires wrapping the issue detail page's root in
`page-wrap`/`board-main` (globals.css:41-66) like the other 3 pages already
do — today it's the only page that skips this wrapper
(`issues/[id]/page.tsx:201`, just a bare `<main className="recap-wrap">`),
which is also why it has no independently-scrolling body region. Add
`logout` to its existing `useAuth()` destructure (`issues/[id]/page.tsx:74`)
to wire the header's sign-out control.

Delete `.recap-head`, `.recap-state`, `.recap-conn` (globals.css:1757-1774)
once the issue page no longer references them (confirm via
`grep -rn recap-head src` returns nothing first).

### 2. Unified status layer — `src/lib/status-display.ts` (new)

```ts
export function deriveIssueDisplayStatus(issue: Pick<Issue,'state'>): { key: FunnelColumn; label: string }
export function deriveTopicDisplayStatus(topic: Pick<Topic,'status'>, issueStates: IssueState[]): { key: FunnelColumn; label: string }
```

Both reuse the board's own existing derivation functions —
`funnelColumnForIssue` and `funnelColumnForTopicWithIssues`
(`src/lib/funnel.ts:47-73`, the same functions
`projects/[id]/page.tsx:220-221` already uses to place cards in columns) — so
the issue detail header shows the *same* label the board uses for that
issue's column, closing the "Backlog" (issue page) vs. "Ready" (board)
mismatch. Topic labels keep the existing plain-language copy
(`TOPIC_STATUS_LABELS`); only the color/tone becomes funnel-derived.

Pair with a small `StatusPill` component (`src/components/status-pill.tsx`)
and one shared CSS class (`.status-pill` + tone modifiers, replacing
`.proj-badge`/`.topic-status`, globals.css:3007-3030 and 3156-3182), reusing
the exact same color tokens the board's
`.dot.idea/.ready/.realizing/.rollout/.delivered` already use
(globals.css:758-772) — no new hex values.

**Two visible, deliberate consequences to call out (not new design choices,
correctness fixes — confirmed while building the mockup artifact):**
- A `shipped` topic's status pill currently renders cyan
  (`.topic-status-shipped`, globals.css:3175-3177) but funnel-maps to
  `delivered`, whose tone is muted gray (matching `.dot.delivered`). Under
  the unified pill it becomes muted gray.
- A `ready` topic's status pill currently renders **green**
  (`.topic-status-ready`, globals.css:3165-3168, using `--pr`) but
  funnel-maps to `ready`, whose tone is muted gray (`--backlog`, matching the
  board's own "Ready" column dot). Under the unified pill it becomes muted
  gray too — the more noticeable of the two changes, since green currently
  reads as a "success" signal shared with three unrelated things (healthy
  project, open PR, ready idea); gray is the correct, less overloaded choice,
  but it's a real, visible color change on every idea in "Ready" status, not
  just "shipped" ones.

Add `src/lib/status-display.test.ts` mirroring the existing table-driven
style of `src/lib/funnel.test.ts`.

### 3. Shared `IssueRef` component — `src/components/board/issue-ref.tsx` (new)

```ts
interface IssueRefProps {
  issue: { owner: string; repo: string; number: number; title: string };
  variant?: 'full' | 'chip';   // full: "owner/repo #number: title"; chip: "owner/repo #number"
  className?: string;
}
```

Replaces the ad hoc `"{owner}/{repo} #{number}: {title}"` string composed
independently in `issues/[id]/page.tsx:215`,
`topics/[id]/page.tsx:435-436,590`, `delivered-section.tsx:27`,
`(board)/page.tsx:520-526` (global search), `develop-modal.tsx:34-35`,
`card-actions-sheet.tsx:24-26`. Callers keep owning the surrounding link
element (`<a>`/`<Link>`/plain text in a `<li>`) — `IssueRef` renders only the
text.

**Deliberate exception:** `issue-card.tsx:76-79`'s kanban-card repo strip is
*not* migrated — it uses a per-repo `repoColor()` for fast visual scanning on
the board, a distinct, already-intentional affordance that a generic muted
chip shouldn't absorb.

### 4. De-duplication changes

**Issue detail breadcrumb** (`issues/[id]/page.tsx:219-236`): compare
`breadcrumb.topicTitle` against `issue.title` (both already in state). If
they match (the common case), render the link text as `"Idea"` instead of
repeating the title already shown in the page's own heading. If they differ
(the idea was edited after realization), show the actual current topic
title — now genuinely new information.

**Idea page "How it was built" list** (`topics/[id]/page.tsx:585-598`): when
there's exactly one linked issue and its title matches the topic's own
`<h1>` (the common case), render only `<IssueRef variant="chip">`
(owner/repo/#number) plus a real `<StatusPill>` (replacing the raw
parenthetical `({i.state})` text). When there are multiple issues, or a
title has diverged, use `variant="full"` so each row stays disambiguated.

### 5. `.recap-title` → real `<h1>`

`issues/[id]/page.tsx:213-217` currently renders the issue's title in a
`<div>`, unlike the idea page's real `<h1 className="topic-detail-title">`.
Change the tag to `<h1>` and add `margin: 0 0 16px;` to `.recap-title`
(globals.css:1776-1781) so the browser's default `<h1>` margin doesn't
introduce an unwanted gap under the new header.

## Non-goals

- No new color palette or visual rebrand — same GitHub-dark tokens
  throughout.
- The cockpit's "Ideas" preview list (`projects-home.tsx`,
  `.project-idea-item` etc.) is a separate list of topics only (no linked
  GitHub issues), so it doesn't have the same duplication problem and is
  left untouched.
- `issue-card.tsx`'s color-coded repo strip stays as its own presentation
  (see §3).

## Migration order (keeps the app buildable at every step; no `.tsx` test
harness exists today — `vitest.config.ts` only covers `src/**/*.ts`, so
verification of UI changes is manual via the dev server)

1. Baseline: `npm run typecheck && npm run lint && npm test`.
2. Add `src/lib/status-display.ts` + test (unused so far).
3. Add `.status-pill*`/`.issue-ref-chip` CSS alongside the existing classes
   (no deletions yet).
4. Add `IssueRef` and `StatusPill` components (unused so far).
5. Add `AppHeader` (unused so far).
6. Migrate pages to `AppHeader`, one at a time, dev-server-checked at desktop
   + 768px mobile width after each: cockpit → board → idea detail → issue
   detail (issue detail last: it's the only one needing the
   `page-wrap`/`board-main` wrapper change too).
7. Migrate the remaining `IssueRef` call sites (`delivered-section.tsx`,
   global search, `develop-modal.tsx`, `card-actions-sheet.tsx`) —
   independent of header work.
8. Unify `.recap-wrap`/`.topic-detail` to the shared 760px shell; standardize
   panel padding/radius and section-label size (§0.5) — dev-server-checked
   on both detail pages.
9. Extend `flex-wrap: wrap` to the delivered ticker and "how it was built"
   list at 640px; consolidate `.action-strip`/`.delivered-section` into
   `.strip`/`.strip--live`/`.strip--muted`; delete dead
   `.released-strip`/`.closed-strip`; add the long-ticker chevron (§0.6) —
   checked on cockpit and board at both desktop and phone width.
10. Once `grep -rn "recap-head|recap-state|recap-conn|proj-badge|topic-status\b|released-strip|closed-strip" src`
    returns nothing, delete the superseded CSS classes.
11. Final gate: `npm run lint && npm run typecheck && npm test && npm run
    build`, then a manual walkthrough of all 4 pages (desktop + mobile)
    checking: header consistency, status pill matches the board's column for
    the same issue/topic across all 6 `IssueState` / 6 `TopicStatus` values,
    breadcrumb/"how it was built" show "Idea"/chip in the matching-title case
    and full text in the divergent case, delivered/closed lists wrap
    correctly on a phone, and sign-out/avatar/connection-dot still work on
    every page.

## Verification

- `npm run typecheck && npm run lint && npm test && npm run build` after
  each migration step above.
- Dev server (`node scripts/dev/start-dev.mjs --port 3111`, or the `run`
  skill) for manual checks: open `/`, `/projects/[id]`, `/topics/[id]`,
  `/issues/[id]` for a topic↔issue pair with matching titles (should show
  "Idea", not a repeated title) and one with a manually-edited topic title
  (should show the divergent title), at both desktop and 768px-mobile
  widths.
- Cross-check: for one issue in each of the 6 `IssueState` values, confirm
  its detail-page status pill label matches the board column it actually
  sits in on `/projects/[id]`.
- On a phone-width viewport, confirm the cockpit's Delivered ticker, a
  project board's Delivered ticker, and the idea page's "How it was built"
  list all wrap onto multiple lines instead of requiring horizontal scroll.
