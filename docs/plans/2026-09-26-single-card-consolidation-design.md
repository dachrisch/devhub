# Single-card consolidation + repo health dashboard (2026-09-26)

Two related but independently-implementable pieces below: **Part 1** folds
the work item into the idea studio (routing/rendering consolidation only).
**Part 2** adds a gh-dash-style repo health view (new GitHub reads + a new
integrate action) — separate scope, separate implementation plan, can land
in either order but is written up together since both touch how "repo"
surfaces in the UI.

## Part 1: fold work items into the idea studio

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

`github.ts` ingest already backfills a topic for every issue at creation
time ("Unified funnel backfill (Phase 4): everything is born an idea",
`src/lib/github.ts:637-654`), so new issues always arrive with a topic.

**Correction:** issues can still lose their topic later — `deleteTopic`
(`src/lib/store.ts:1189-1198`, reachable via `DELETE /api/topics/[id]`,
`src/app/api/topics/[id]/route.ts:87-103`) nulls `topic_id` on every
linked issue before deleting the topic. `delivered-section.tsx`'s "orphan
issues (no topic) keep the flat ribbon" comment (line 61) confirms this
is a real, currently-reachable case, not a legacy artifact. Fix: extract
the `createTopic` + `assignIssue` pairing `github.ts:647-653` already does
into a shared helper, `backfillTopicForIssue(issue: Issue): Topic` in
`store.ts` — `createTopic({ title: issue.title, notes: issue.body,
projectId: issue.projectId, status: 'ready' })` then
`assignIssue(issue.id, { topicId: topic.id })`. `github.ts`'s ingest
backfill calls it instead of duplicating the pairing; `deleteTopic` calls
it once per linked issue instead of nulling `topic_id`, so deleting an
idea never leaves its GitHub-tracked work without a home. This same
helper is what Part 2's `Integrate` action calls, below. With this fix,
`Issue.topicId` is non-null in every reachable state, not just at ingest.

(Project's "settings-only page" row above gains a richer counterpart in
Part 2 below — the health dashboard — but stays out of the dashboard card
rotation either way.)

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
- **Correction after checking `kanban-board.tsx`:** `issue-card.tsx`
  (`IssueCard`/`MobileIssueCard`/`IssueCardSheet`) is *not* dead code — it's
  the board's primary card for issues in the `ready`/`realizing`/`rollout`
  funnel columns (batch-select checkbox, `DevelopModal` to start work,
  transition/merge actions, run chips), distinct from `UnifiedTopicCard`
  which only renders the `idea` column. It stays as its own component —
  no retirement, no rendering unification with `UnifiedTopicCard`. Its
  title link (`issue-card.tsx:93`) and non-"work" primary footer link
  (`issue-card.tsx:151`) currently go to `/issues/${issue.id}`; both
  change to `/topics/${issue.topicId}` (always non-null per the backfill).
  `CardActionsMenu`'s existing `open-github` action
  (`issue-card.tsx:67-69`, already opens `issue.htmlUrl`) needs no change —
  it's already the "view raw issue on GitHub" affordance this design
  wants. `MobileCard`'s equivalent links get the same fix.
- `board-ui.ts`'s `cardActions()` (lines 190-192) pushes `open-studio`
  only when `issue.topicId != null`, and unconditionally pushes `recap`
  (line 193-196) — once every issue always has a topic, `open-studio` and
  `recap` point at the same destination, so `open-studio` becomes dead
  weight. Remove the `open-studio` push; `recap`'s existing conditional
  label ("Recap"/"Recap (live)") is unchanged. In `card-actions-menu.tsx`
  and `card-actions-sheet.tsx`, delete the now-unreachable
  `action.id === 'open-studio'` branch in each and change the `'recap'`
  branch's `href` from `/issues/${issue.id}` to `/topics/${issue.topicId}`.
- `delivered-section.tsx`: the nested per-issue lines inside a topic
  ribbon (line 98, `href={`/issues/${w.issue.id}`}`) become external —
  add `htmlUrl` to the `work` mapping's issue shape (line 55) alongside
  the existing `id, owner, repo, number, title` fields, link to
  `w.issue.htmlUrl`. The orphan-issue branch (lines 61-73) becomes
  defensive-only once the `deleteTopic` fix above lands; keep it, but
  change its `href` (line 67) to `i.topicId != null ? `/topics/${i.topicId}` :
  i.htmlUrl` rather than assuming orphan issues are the norm.
- `mobile-search-sheet.tsx:100` (`href={`/issues/${issue.id}`}`) and
  `(board)/page.tsx:519` (`href={`/issues/${i.id}`}`, the "Recap →" link
  in global search results) both become
  `issue.topicId != null ? `/topics/${issue.topicId}` : issue.htmlUrl`.

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

## Part 2: repo health dashboard (gh-dash-style)

Modeled on `gh-dash`: for a given repo, surface open PRs (review + CI
status), default-branch pipeline status, and the full open-issue list
cross-referenced against DevHub topics, with a manual **Integrate** action
for issues that aren't tracked yet — the on-ramp for tickets filed by
other contributors directly on GitHub rather than through DevHub.

### Scope

Works for **any** GitHub repo reachable with the stored token, not only
`GITHUB_TOPICS`-matched ones (per your call — closer to gh-dash itself
than to a DevHub-only view). A managed repo (existing `Project` row)
shows this as a section on `/projects/[id]`. An unmanaged repo is reached
through a new repo picker and renders the same content without a `Project`
existing yet — the route resolves by `owner/repo`
(`/projects/by-repo/[owner]/[repo]`), redirecting to the numeric
`/projects/[id]` once one exists. The first `Integrate` click (or an
explicit "Track this repo") creates the `Project` via the existing
`ensureProjectForRepo` — the same function the automatic ingest sweep
already uses, so a repo doesn't need two different "how do I get a
Project" code paths.

### Repo picker

New surface (search field alongside the existing repo filter chips).
Backed by the repo list DevHub already fetches every ingest sweep
(`GET /user/repos` in `refreshIssues`, `src/lib/github.ts:607`) — today
discarded unless it matches `repoMatchesTopics`. No new GitHub call, just
stop discarding non-matching repos before this specific listing, and flag
each with whether a `Project` already exists.

### Health section (per repo)

Three live-fetched panels — computed on page load, not persisted or
polled, same trust boundary as the rest of the app's token-scoped reads:

- **Pipeline**: latest GitHub Actions run on the repo's default branch
  (`GET /repos/{o}/{r}/actions/runs?branch={default}&per_page=1`) —
  green / red / running. Needs `default_branch` added to the `GhRepo`
  shape (not currently captured).
- **Open PRs**: `GET /repos/{o}/{r}/pulls?state=open`, each annotated
  with review state and CI status for its head SHA (check-runs for that
  ref). This is the "anything to react on" signal: failing checks,
  changes requested, mergeable-and-idle.
- **Issues**: `GET /repos/{o}/{r}/issues?state=open`, filtered through
  the existing `isPullRequest`/`isBotIssue` guards (same as ingest).
  Cross-referenced by `githubIssueId` against stored issues
  (`getIssueByGithub`): already-tracked ones show a small "tracked →
  topic" indicator (dedup — not a second card); untracked ones get the
  **Integrate** button.

### Integrate action

New route, e.g. `POST /api/repos/[owner]/[repo]/issues/[number]/integrate`
— calls `ensureProjectForRepo` then the same `createTopic` + `assignIssue`
pairing the automatic backfill already performs in
`src/lib/github.ts:646-653`. That pairing should be factored into a
shared helper so the automatic sweep and this manual action can't drift
apart. `status: 'ready'` on creation, matching the existing backfill
rationale (a GitHub issue already carries a written spec).

### Data flow

No new auth/token handling — reuses the per-session GitHub token already
used for ingest and issue actions. New read-only calls: PR list +
check-runs per PR, actions runs for the default branch, issue list for an
arbitrary (possibly unmanaged) repo. Only `Integrate` writes, and it
writes through existing, already-tested paths.

### Testing

- Route test for `Integrate`: idempotent on repeat calls for the same
  issue (mirrors the existing ingest backfill's idempotency — "Idempotent
  by the topicId check" comment at `github.ts:642`).
- Mocked-GitHub tests for the health section's pass/fail/running
  rendering, following this repo's existing mocked-GitHub fixture pattern
  used for board tests.

## Deferred (separate scope)

Mobile/visual triage (oversized text/elements seen on the topic page,
project board, and home screenshots) is explicitly deferred until after
Part 1 ships — auditing screens that are about to be restructured would
be partly wasted work. Once Part 1 lands, a follow-up pass audits and
prioritizes the *resulting* surfaces (fewer of them, since `/issues/[id]`
is gone) for mobile sizing. Part 2 is independent of this deferral and can
land before or after the mobile pass.
