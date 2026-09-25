# Single-card consolidation: fold work items into the idea studio (2026-09-26)

Branch: `ui/redesign-polish` (continues on top of the unified-funnel work:
`2026-09-09-hub-unified-funnel-plan.md`, `d1dfd82` two-verb funnel / lineage
cards / triage-first home).

## Target

The operator should only ever deal with one card: the idea (topic). A repo is
metadata on that card, not a card of its own. A GitHub issue is work attached
to an idea, not a second place to navigate to. Full merge, no compatibility
redirect for the old issue route — confirmed by user, accepted as a breaking
change for any bookmarked `/issues/N` links.

| Entity | Today | After |
|---|---|---|
| Topic (idea) | Primary card, own page `/topics/[id]` | Unchanged — becomes the *only* work surface |
| Issue (GitHub work item) | Own page `/issues/[id]` with run timeline, live feed, mark-shipped | No page. Data renders inline in the topic's Work panel. Raw issue link points at GitHub (`issue.htmlUrl`), not an internal route |
| Project (repo config) | Card on dashboard, grouping on board | No dashboard card. Filter dimension + settings-only page (still owns deploy host/domain/auto-merge/release-mode) |
| Cockpit action | Live status strip only, capped history + "+N more" | Live strip unchanged (in-flight visibility) **plus** a real card section (own history, not capped) |

This is safe to do fully: `github.ts` ingest already backfills a topic for
every issue at creation time ("Unified funnel backfill (Phase 4): everything
is born an idea", `src/lib/github.ts:637-654`) — there is no orphan-issue
case to design around. Every `Issue.topicId` is non-null in practice.

## 1. Topic/studio page — Work panel absorbs the issue page

`src/app/(board)/topics/[id]/page.tsx` already renders a `topic-work-panel`
(lines 615-660): one line per linked issue with state dot, title/chip link,
status pill, PR link, and inline blocked-reason alert. This stays, but each
line's link target and content change:

- Extract the guts of `src/app/(board)/issues/[id]/page.tsx` (state, data
  fetch, SSE subscription, run timeline, live activity feed with
  `FeedPayload`/`activityLine`, mark-shipped action — everything except the
  `AppHeader`/`page-wrap`/breadcrumb navigation chrome) into a reusable
  client component, e.g. `src/components/board/issue-work-detail.tsx`
  (`<IssueWorkDetail issueId={...} />`), keeping its own fetch + SSE
  subscription since the topic page doesn't otherwise load runs/events.
- Render `<IssueWorkDetail>` inline per work-panel item. Single-issue ideas
  (the common case, already detected via the existing `titleMatches`
  dedup) show it expanded by default. Multi-issue ideas keep the compact
  line with a disclosure toggle per item, so the panel doesn't blow up when
  an idea has several runs.
- Auto-expand behavior carries over from today's `recap-live`: while
  `state` is `developing`/`refinement` and not blocked, the live feed
  (the "conversation and everything that happens" log) shows by default;
  once terminal, it collapses to the run summary + PR link with the full
  feed one click away.
- The item's title link (today `href={`/issues/${i.id}`}`) becomes an
  external link to `i.htmlUrl` (GitHub) — "view the raw issue," not app
  navigation. `mark-shipped` and other actions stay as in-panel buttons
  hitting the existing `/api/issues/[id]/...` routes — no API changes
  needed there.
- Line 459 (`firstBlocked` quick-link in the idea's status banner) gets
  the same treatment: link to `i.htmlUrl`, not `/issues/${firstBlocked.id}`.

## 2. Card lineage — dashboard/board cards

`src/components/board/unified-card.tsx`'s `Lineage` sub-component
(`→ owner/repo #N`) currently links to `/issues/${first.id}`. Since the
card's own title/body already opens `/topics/${topic.id}` (the studio, now
the full work surface), the lineage line's link changes to
`linked[0].htmlUrl` — external, GitHub. Needs `htmlUrl` added to the
`LinkedWork` interface (currently `id, owner, repo, number, state`) and
threaded through wherever `LinkedWork[]` is built for card props.

## 3. Route and dead-code removal

- Delete `src/app/(board)/issues/[id]/page.tsx` and its route directory —
  no redirect.
- `src/components/board/issue-card.tsx` and `mobile-card.tsx` predate the
  unified card (per `2026-09-09-hub-unified-funnel-plan.md`, kept for
  `backlog` issues without a topic — a case that no longer exists per the
  backfill above). Implementation should verify remaining call sites
  render `UnifiedTopicCard`/`MobileUnifiedTopicCard` instead and retire
  these components if confirmed unused, rather than leaving a second card
  implementation to link-fix in step 4.
- Fix remaining internal `/issues/${...}` links found in
  `delivered-section.tsx`, `card-actions-menu.tsx`, `card-actions-sheet.tsx`,
  `mobile-search-sheet.tsx`, and `(board)/page.tsx:519` — each becomes an
  external `htmlUrl` link (if it's "view the raw issue") or a
  `/topics/${topicId}` link (if it's "go manage this work"), decided per
  call site during implementation.

## 4. Dashboard — unified idea list + cockpit cards

`src/components/board/projects-home.tsx` (the current per-project grouped
home) and `src/app/(board)/page.tsx`'s loader change to:

- Fetch topics across all projects flat (not grouped), sorted by the
  existing triage ordering. Each `UnifiedTopicCard` gains a repo
  chip/badge sourced from its linked issue(s) or project mapping.
- A filter control narrows by repo/project (chip-style, consistent with
  existing repo filter chips already used on the project board).
- Project stops rendering as a card. Its settings (deploy host, domain,
  auto-merge, release mode) move to a settings-only surface — not
  in scope to redesign that page's content, only to stop surfacing it as
  a dashboard card.
- Cockpit actions get a dedicated card section (reusing the card shell,
  or a close variant) fed from the already-persisted action history
  (`GET /api/action`) instead of only the capped 3 + "+N more" strip.
  The live strip (pulse, in-flight count) stays as-is for real-time
  visibility; the FAB still dispatches new actions.

## Data flow

No new persistence needed — `DevelopRun`, `IssueEvent`, and cockpit
`ActionRow` are all already stored and served by existing API routes
(`/api/issues/[id]/runs`, the issue SSE stream, `/api/action`,
`/api/action/[id]`). This is a rendering/routing consolidation, not a
schema change. The one interface change is `LinkedWork` gaining `htmlUrl`
(already present on `Issue`, just not currently passed through).

## Error handling

- Deleting the issue route without a redirect means any stale external
  link to `/issues/N` 404s. Accepted (explicit user decision).
- `IssueWorkDetail`'s SSE subscription and fetch failure states reuse the
  existing patterns from `issues/[id]/page.tsx` (connection indicator,
  retry) rather than inventing new ones.

## Testing

- `src/lib/board-ui.test.ts` / `status-display.test.ts` already cover
  column/status derivation — extend for the flat dashboard sort if it
  introduces new logic beyond existing triage ordering.
- New tests for `issue-work-detail.tsx` (extracted from today's
  implicit coverage of the issues page, if any exists — check first).
- Regression check: no remaining internal link points at
  `/issues/[id]` anywhere in `src/` after the change (grep-based
  acceptance, mirroring how prior phases in this repo's plans verify
  "no `Work` on ideas" etc.).
- `headless-check.mjs` smoke pass on `/`, `/topics/<id>`, `/projects/<id>`
  per this repo's existing acceptance pattern.

## Deferred (separate scope)

Mobile/visual triage (oversized text/elements seen on the topic page,
project board, and home screenshots) is explicitly deferred until after
this merge ships — auditing screens that are about to be restructured
would be partly wasted work. Once this lands, a follow-up pass audits and
prioritizes the *resulting* surfaces (fewer of them, since `/issues/[id]`
is gone) for mobile sizing.
