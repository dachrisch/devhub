# Fold issue detail into the topic studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `/issues/[id]` as a page; every place that used to link there
(cards, menus, search, delivered history) links to `/topics/[topicId]`
instead, and the topic/studio page's existing Work panel gains an inline,
expandable panel per linked issue with the run timeline, live agent
activity feed, and mark-shipped action that page used to own.

**Architecture:** A new presentational component, `IssueWorkDetail`, renders
what `/issues/[id]/page.tsx` used to render (minus its own page chrome and
data fetching). The topic page — which already holds a single shared SSE
subscription and a list of linked issues — takes over owning that data:
one fetch per linked issue on load, plus new `run`/`opencode-event`
handling in its existing SSE handler. No new API routes; no schema change.
A data-integrity gap found along the way (deleting a topic could orphan
its linked issues) gets fixed with a small shared helper reused by both
the existing ingest backfill and the fix.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, `better-sqlite3`,
`vitest`. No component-level tests exist anywhere in this codebase today
(`src/components/`, `src/app/` have none) — only `src/lib/*.test.ts`. This
plan follows that convention: pure logic (`store.ts`, `board-ui.ts`) gets
TDD unit tests; page/component changes are verified by `npm run typecheck`,
`npm run lint`, `npm run test` (full existing suite must stay green), and
`node scripts/dev/headless-check.mjs --path <route>` smoke checks, matching
how prior UI phases in this repo (`docs/plans/2026-09-09-hub-unified-funnel-plan.md`)
were verified.

**Spec:** `docs/plans/2026-09-26-single-card-consolidation-design.md`
(Part 1, sections 1–3). Read it alongside this plan — it has the full
rationale for each decision below.

## Global Constraints

- No compatibility redirect for `/issues/[id]` — confirmed by the user,
  a stale external link 404s. Do not add one.
- `Issue.topicId` must be non-null in every reachable state once this
  plan lands — Task 2 closes the one gap that broke this (topic
  deletion). Any new code path that creates or reassigns issues must
  preserve this invariant.
- Don't add a second `EventSource`/SSE subscription per linked issue.
  The topic page owns one shared subscription already (`topics/[id]/page.tsx:163`);
  extend it, don't parallel it.
- Follow the existing repo convention: no new `.tsx`/`.jsx` test files.
  Verify UI work via `npm run typecheck && npm run lint && npm run test`
  plus the headless smoke script.

## Review Focus

- **Multi-issue idea.** An idea can have more than one linked issue (a
  service + infra pair, or a re-run after a merge). The work panel must
  render one `IssueWorkDetail` per issue without them fighting over
  shared state — each keeps its own runs/events keyed by issue id
  (Task 7).
- **Topic deletion with linked issues.** `DELETE /api/topics/[id]` must
  never leave an issue with `topic_id = NULL` after this plan (Task 2)
  — this was a real, reachable bug before this plan, not a hypothetical.
- **Live agent run in progress when the topic page is opened.** The
  live activity feed (via `opencode-event` SSE messages) must appear
  without a page reload — it's the feature the user explicitly said to
  preserve. Task 7's SSE extension is the only place this can regress.
- **An issue whose topic no longer matches any card's assumption.**
  `mobile-search-sheet.tsx` and `(board)/page.tsx`'s global search render
  issues fetched independently of the topic page; both must use
  `issue.topicId`, never assume it came from a page that already
  filtered for it (Task 5).
- **`recap` menu action after `open-studio` removal.** `cardActions()`
  is exercised with many `(state, blockedReason, live)` combinations in
  `board-ui.test.ts`; removing `open-studio` must not silently change
  `recap`'s position or label logic for any of those (Task 4).

---

### Task 1: `backfillTopicForIssue` shared helper

**Files:**
- Modify: `src/lib/store.ts` (add new exported function, near `getIssuesByTopic` at line ~1100)
- Test: `src/lib/store.test.ts`

**Interfaces:**
- Produces: `backfillTopicForIssue(issue: Issue): Topic` — creates a topic
  titled after the issue (`title: issue.title, notes: issue.body,
  projectId: issue.projectId ?? null, status: 'ready'`), links the issue
  to it via `assignIssue`, and returns the new `Topic`. Tasks 2 and 3
  (and Part 2's future `Integrate` action) call this.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/store.test.ts` (inside the existing `describe('store', ...)` block):

```ts
  it('backfills a fresh ready topic for an issue and links it', () => {
    store.upsertIssue({
      githubIssueId: 501,
      owner: 'dachrisch',
      repo: 'widget',
      number: 5,
      title: 'Fix the thing',
      body: 'Some details',
      htmlUrl: 'https://github.com/dachrisch/widget/issues/5',
    });
    const issue = store.getIssueByGithub('dachrisch', 'widget', 5)!;
    expect(issue.topicId).toBeNull();

    const topic = store.backfillTopicForIssue(issue);

    expect(topic.title).toBe('Fix the thing');
    expect(topic.notes).toBe('Some details');
    expect(topic.status).toBe('ready');
    const refreshed = store.getIssue(issue.id)!;
    expect(refreshed.topicId).toBe(topic.id);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- store.test.ts -t "backfills a fresh ready topic"`
Expected: FAIL — `store.backfillTopicForIssue is not a function`

- [ ] **Step 3: Implement it**

In `src/lib/store.ts`, add (near `getIssuesByTopic`, using the existing
`createTopic`/`assignIssue` defined in the same file):

```ts
// Gives an issue a fresh, linked topic. Used by the ingest backfill (every
// GitHub issue is "born an idea") and by deleteTopic (an issue must never
// lose its topic — see docs/plans/2026-09-26-single-card-consolidation-design.md).
export function backfillTopicForIssue(issue: Issue): Topic {
  const topic = createTopic({
    title: issue.title,
    notes: issue.body,
    projectId: issue.projectId ?? null,
    status: 'ready',
  });
  assignIssue(issue.id, { topicId: topic.id });
  return topic;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- store.test.ts -t "backfills a fresh ready topic"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "feat(store): add backfillTopicForIssue helper"
```

---

### Task 2: `deleteTopic` backfills instead of orphaning linked issues

**Files:**
- Modify: `src/lib/store.ts:1189-1198` (`deleteTopic`)
- Test: `src/lib/store.test.ts`

**Interfaces:**
- Consumes: `backfillTopicForIssue(issue: Issue): Topic` (Task 1),
  `getIssuesByTopic(topicId: number): Issue[]` (existing, `store.ts:1100`).
- Produces: `deleteTopic(id: number): void` — same signature, new
  behavior: every issue linked to the deleted topic gets a fresh topic
  via `backfillTopicForIssue` instead of `topic_id` being set to `NULL`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/store.test.ts`:

```ts
  it('backfills a replacement topic for linked issues instead of orphaning them on delete', () => {
    const topic = store.createTopic({ title: 'Doomed idea' });
    store.upsertIssue({
      githubIssueId: 502,
      owner: 'dachrisch',
      repo: 'widget',
      number: 6,
      title: 'Linked work',
      body: null,
      htmlUrl: 'https://github.com/dachrisch/widget/issues/6',
    });
    const issue = store.getIssueByGithub('dachrisch', 'widget', 6)!;
    store.assignIssue(issue.id, { topicId: topic.id });

    store.deleteTopic(topic.id);

    const refreshed = store.getIssue(issue.id)!;
    expect(refreshed.topicId).not.toBeNull();
    expect(refreshed.topicId).not.toBe(topic.id);
    const newTopic = store.getTopic(refreshed.topicId!)!;
    expect(newTopic.title).toBe('Linked work');
    expect(store.getTopic(topic.id)).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- store.test.ts -t "backfills a replacement topic for linked issues"`
Expected: FAIL — `refreshed.topicId` is `null`, not a new topic id.

- [ ] **Step 3: Implement it**

In `src/lib/store.ts`, replace the existing `deleteTopic`:

```ts
export function deleteTopic(id: number): void {
  // Every issue keeps a home — an issue that would otherwise be orphaned
  // gets a fresh topic instead (single-card consolidation: there is no
  // page for a topic-less issue anymore).
  for (const issue of getIssuesByTopic(id)) {
    backfillTopicForIssue(issue);
  }
  // The options thread goes with the topic (FK cascade is not enforced).
  getDb().prepare(`DELETE FROM idea_messages WHERE topic_id = ?`).run(id);
  // Duplicates merged into this topic lose their winner pointer (FK is not
  // enforced by default in SQLite, so clear explicitly).
  getDb().prepare('UPDATE topics SET merged_into_topic_id = NULL WHERE merged_into_topic_id = ?').run(id);
  getDb().prepare('DELETE FROM topics WHERE id = ?').run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- store.test.ts`
Expected: PASS — including the pre-existing test at line 499-515
(`'keeps the options thread in order and records picks'`), which calls
`deleteTopic` on a topic with **no** linked issues and must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "fix(store): deleteTopic backfills linked issues instead of orphaning them"
```

---

### Task 3: `github.ts` ingest uses the shared helper

**Files:**
- Modify: `src/lib/github.ts:2` (import line), `src/lib/github.ts:646-653`

**Interfaces:**
- Consumes: `backfillTopicForIssue(issue: Issue): Topic` (Task 1).

No new test — this is a pure refactor of the exact logic
`backfillTopicForIssue` was extracted from. The existing test
`'backfills unlinked ingested issues with a native `ready` topic (unified
funnel Phase 4)'` (`src/lib/github.test.ts:144-174`) already covers this
behavior and must still pass unchanged.

- [ ] **Step 1: Update the import**

In `src/lib/github.ts:2`, remove `createTopic` from the import (no longer
used directly in this file) and add `backfillTopicForIssue`:

```ts
import { appendEvent, assignIssue, backfillTopicForIssue, deleteIssueByGithub, ensureProjectForRepo, getIssue, getIssueByGithub, getIssues, getProject, getRunsForIssue, refreshTopicStatus, reopenIssue, setClosed, setLinkedPrUrl, setProjectShipped, setRollout, updateRun, upsertIssue } from './store';
```

- [ ] **Step 2: Replace the inline backfill**

Replace `src/lib/github.ts:646-653`:

```ts
        if (project && stored.topicId === null) {
          const topic = createTopic({
            title: stored.title,
            notes: stored.body,
            projectId: project.id,
            status: 'ready',
          });
          assignIssue(stored.id, { topicId: topic.id });
        }
```

with:

```ts
        if (project && stored.topicId === null) {
          backfillTopicForIssue(stored);
        }
```

- [ ] **Step 3: Run the existing test to confirm behavior is unchanged**

Run: `npm run test -- github.test.ts -t "backfills unlinked ingested issues"`
Expected: PASS

- [ ] **Step 4: Typecheck (unused-import check)**

Run: `npm run typecheck`
Expected: no errors (confirms `createTopic` removal didn't leave a dangling reference and `assignIssue` is still used at `github.ts:635`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/github.ts
git commit -m "refactor(github): ingest backfill uses the shared helper"
```

---

### Task 4: Drop the redundant `open-studio` card action

**Files:**
- Modify: `src/lib/board-ui.ts:190-192`
- Test: `src/lib/board-ui.test.ts:301-306`

**Interfaces:**
- Produces: `cardActions(...)` no longer ever includes an action with
  `id: 'open-studio'`. `recap`'s position/label logic (lines 193-196) is
  unchanged.

Once every issue always has a topic (Tasks 1-3), `open-studio` and
`recap` point at the same destination after Task 5 repoints `recap` —
keeping both is a redundant menu row.

- [ ] **Step 1: Replace the now-obsolete test**

Replace `src/lib/board-ui.test.ts:301-306`:

```ts
  it('issues carrying a shaped idea get an open-studio row back to the thread', () => {
    const base = { state: 'backlog' as const, blockedReason: null };
    expect(cardActions({ ...base, topicId: 7 }, false).some((a) => a.id === 'open-studio')).toBe(true);
    expect(cardActions({ ...base, topicId: null }, false).some((a) => a.id === 'open-studio')).toBe(false);
    expect(cardActions({ ...base, topicId: 7 }, true).some((a) => a.id === 'work')).toBe(false);
  });
```

with:

```ts
  it('never offers a separate open-studio row — recap is the one route back to the studio', () => {
    const base = { state: 'backlog' as const, blockedReason: null };
    expect(cardActions({ ...base, topicId: 7 }, false).some((a) => a.id === 'open-studio')).toBe(false);
    expect(cardActions({ ...base, topicId: null }, false).some((a) => a.id === 'open-studio')).toBe(false);
    expect(cardActions({ ...base, topicId: 7 }, true).some((a) => a.id === 'work')).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- board-ui.test.ts -t "never offers a separate open-studio row"`
Expected: FAIL — `cardActions({ ...base, topicId: 7 }, false)` still includes `open-studio`.

- [ ] **Step 3: Implement it**

Delete `src/lib/board-ui.ts:190-192`:

```ts
  if (issue.topicId != null) {
    actions.push({ id: 'open-studio', label: 'Open studio' });
  }
```

(Leave the `'open-studio'` entry in the `CardActionId` union type at
`board-ui.ts:151` alone for this task — Task 5 removes it once nothing
in `card-actions-menu.tsx`/`card-actions-sheet.tsx` branches on it
anymore, avoiding an unused-type intermediate state.)

- [ ] **Step 4: Run the full board-ui test file**

Run: `npm run test -- board-ui.test.ts`
Expected: PASS — including the other `cardActions` tests at lines 47-105, which don't set `topicId` and were never exercising the removed branch.

- [ ] **Step 5: Commit**

```bash
git add src/lib/board-ui.ts src/lib/board-ui.test.ts
git commit -m "fix(board-ui): drop redundant open-studio card action"
```

---

### Task 5: Repoint every remaining internal `/issues/[id]` link

**Files:**
- Modify: `src/lib/board-ui.ts:151` (remove `'open-studio'` from `CardActionId`)
- Modify: `src/components/board/card-actions-menu.tsx:61-80`
- Modify: `src/components/board/card-actions-sheet.tsx:30-50`
- Modify: `src/components/board/issue-card.tsx:93,151`
- Modify: `src/components/board/mobile-card.tsx:38,79`
- Modify: `src/components/board/delivered-section.tsx:54-58,61-73,98`
- Modify: `src/components/board/mobile-search-sheet.tsx:100`
- Modify: `src/app/(board)/page.tsx:519`
- Modify: `src/components/board/unified-card.tsx:17-23,118-130` (`LinkedWork`
  gains `htmlUrl`; `Lineage` links there instead of `/issues/${first.id}`)
- Modify: `src/components/board/kanban-board.tsx` (wherever it builds the
  `Map<number, LinkedWork[]>` passed to `UnifiedTopicCard` — grep for
  `LinkedWork` construction and add `htmlUrl: issue.htmlUrl` to each entry)

All of these are the same mechanical change — a link that pointed at the
soon-to-be-deleted `/issues/[id]` now points either at `/topics/[topicId]`
(internal, "go manage this work") or `issue.htmlUrl` (external, "view the
raw issue on GitHub"). Grouped into one task because the acceptance check
is the same for all of them and none is independently interesting.

- [ ] **Step 1: Write the failing regression check**

This repo has no component tests, so the check is a plain grep run as a
script, matching how prior UI phases in this repo verified "no `Work` on
ideas" etc. (`docs/plans/2026-09-09-hub-unified-funnel-plan.md`):

Run:
```bash
grep -rn '/issues/\${' src/components src/app --include='*.tsx' | grep -v "issues/\[id\]/page.tsx"
```
Expected right now: matches in every file listed above (confirms the
check finds real, not-yet-fixed instances before you start).

- [ ] **Step 2: `card-actions-menu.tsx`**

In `src/components/board/card-actions-menu.tsx`, replace the ternary
branch at lines 61-80:

```tsx
          {actions.map((action) =>
            action.id === 'recap' ? (
              <Link
                key={action.id}
                href={`/issues/${issue.id}`}
                className="card-menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                {action.label}
              </Link>
            ) : action.id === 'open-studio' && issue.topicId != null ? (
              <Link
                key={action.id}
                href={`/topics/${issue.topicId}`}
                className="card-menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                {action.label}
              </Link>
            ) : (
```

with:

```tsx
          {actions.map((action) =>
            action.id === 'recap' ? (
              <Link
                key={action.id}
                href={`/topics/${issue.topicId}`}
                className="card-menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                {action.label}
              </Link>
            ) : (
```

(closing paren count is unchanged — one branch removed, not restructured)

- [ ] **Step 3: `card-actions-sheet.tsx`**

Same shape, at lines 30-50: delete the `action.id === 'open-studio'`
branch, change the `'recap'` branch's `href` from `/issues/${issue.id}`
to `/topics/${issue.topicId}`.

- [ ] **Step 4: `board-ui.ts` — clean up the now-unused type member**

In `src/lib/board-ui.ts:141-151`, remove `| 'open-studio'` from the
`CardActionId` union (Task 4 already removed the value that produced it;
Steps 2-3 above removed its last consumers).

- [ ] **Step 5: `issue-card.tsx`**

Lines 93 and 151, both `href={`/issues/${issue.id}`}` → `href={`/topics/${issue.topicId}`}`.

- [ ] **Step 6: `mobile-card.tsx`**

Lines 38 and 79, same change: `href={`/issues/${issue.id}`}` → `href={`/topics/${issue.topicId}`}`.

- [ ] **Step 7: `delivered-section.tsx`**

Line 54-58, add `htmlUrl` to the per-topic `work` mapping's issue shape:

```ts
        work: work.map((i) => ({
          issue: { id: i.id, owner: i.owner, repo: i.repo, number: i.number, title: i.title, htmlUrl: i.htmlUrl },
          tag: issueTag(i),
          at: i.updatedAt,
        })),
```

Line 98, `href={`/issues/${w.issue.id}`}` → `href={w.issue.htmlUrl}` (this
is now an external link — add `target="_blank" rel="noreferrer"`).

Line 67 (the orphan-issue ribbon — defensive only after Task 2, since
issues no longer lose their topic), `href: `/issues/${i.id}`` →
`href: i.topicId != null ? `/topics/${i.topicId}` : i.htmlUrl`.

- [ ] **Step 8: `mobile-search-sheet.tsx`**

Line 100: `href={`/issues/${issue.id}`}` →
`href={issue.topicId != null ? `/topics/${issue.topicId}` : issue.htmlUrl}`.

- [ ] **Step 9: `(board)/page.tsx`**

Line 519: `href={`/issues/${i.id}`}` →
`href={i.topicId != null ? `/topics/${i.topicId}` : i.htmlUrl}`.

- [ ] **Step 10: `unified-card.tsx` — `LinkedWork` gains `htmlUrl`**

`src/components/board/unified-card.tsx:17-23`:

```ts
export interface LinkedWork {
  id: number;
  owner: string;
  repo: string;
  number: number;
  state: Issue['state'];
  htmlUrl: string;
}
```

Line 124, inside `Lineage`:

```tsx
      <Link href={`/issues/${first.id}`} className="card-lineage-link">
```

becomes:

```tsx
      <a href={first.htmlUrl} target="_blank" rel="noreferrer" className="card-lineage-link">
```

(and the closing `</Link>` on the next line becomes `</a>` — this is now
an external link, not a Next `Link`; drop the `next/link` import if
`unified-card.tsx` no longer uses `Link` anywhere else — check with
`grep -n '<Link' src/components/board/unified-card.tsx` before removing
the import, since the card title link at line 56/92 still uses it).

- [ ] **Step 11: `kanban-board.tsx` — thread `htmlUrl` into `LinkedWork[]`**

Run `grep -n "owner: .*\.owner" src/components/board/kanban-board.tsx` to
find where `LinkedWork` objects are constructed for the
`Map<number, LinkedWork[]>` passed as `linkedIssues`. Add `htmlUrl:
<issue>.htmlUrl` alongside the existing `owner`/`repo`/`number`/`state`
fields at that construction site.

- [ ] **Step 12: Re-run the regression check**

Run:
```bash
grep -rn '/issues/\${' src/components src/app --include='*.tsx' | grep -v "issues/\[id\]/page.tsx"
```
Expected: no matches.

- [ ] **Step 13: Typecheck, lint, full test suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

- [ ] **Step 14: Commit**

```bash
git add src/lib/board-ui.ts src/components/board/card-actions-menu.tsx src/components/board/card-actions-sheet.tsx src/components/board/issue-card.tsx src/components/board/mobile-card.tsx src/components/board/delivered-section.tsx src/components/board/mobile-search-sheet.tsx "src/app/(board)/page.tsx" src/components/board/unified-card.tsx src/components/board/kanban-board.tsx
git commit -m "refactor(board): repoint every internal issue link at the topic studio or GitHub"
```

---

### Task 6: Extract `IssueWorkDetail` (presentational)

**Files:**
- Create: `src/components/board/issue-work-detail.tsx`
- Reference (do not modify yet): `src/app/(board)/issues/[id]/page.tsx`

**Interfaces:**
- Consumes: nothing new — reuses `activityLine`, `condense`, `eventText`,
  `isNoise`, `truncateText` from `@/lib/recap`, `<Markdown>` from
  `@/components/markdown`, `relTime` from `@/lib/board-ui`.
- Produces:
  ```ts
  export interface IssueWorkDetailProps {
    issue: Issue;
    events: IssueEvent[];
    runs: DevelopRun[];
    connected: boolean;
    onMarkShipped: () => void;
    shipping: boolean;
  }
  export function IssueWorkDetail(props: IssueWorkDetailProps): JSX.Element
  ```
  Task 7 owns fetching `events`/`runs`/`connected` and the `onMarkShipped`
  callback; this component only renders them.

This is presentational-only — no fetch, no `EventSource`, no route
params. Pulled from `src/app/(board)/issues/[id]/page.tsx`'s render body
(lines 22-67 for the feed-formatting helpers, lines 271-383 for the JSX),
dropping the `AppHeader`/`page-wrap`/breadcrumb chrome (lines 225-269)
that belonged to the standalone page.

- [ ] **Step 1: Create the file**

```tsx
'use client';

import type { DevelopRun, Issue, IssueEvent } from '@/lib/types';
import { relTime } from '@/lib/board-ui';
import { activityLine, condense, eventText, isNoise, truncateText } from '@/lib/recap';
import { Markdown } from '@/components/markdown';

function modelLabel(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as { id?: unknown; providerID?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const provider = typeof p.providerID === 'string' ? p.providerID : '';
  return provider ? `${id} (${provider})` : id;
}

function validationLabel(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as { status?: unknown; ready?: unknown; summary?: unknown };
  const status = typeof p.status === 'string' ? p.status : '';
  if (status === 'started') return 'Refinement started';
  const ready = p.ready === true;
  const summary = typeof p.summary === 'string' ? p.summary : '';
  return summary ? `Refinement ${ready ? 'passed' : 'needs input'}: ${summary}` : `Refinement ${ready ? 'passed' : 'needs input'}`;
}

function feedContent(e: IssueEvent): { markdown: string } | { plain: string } {
  if (e.kind === 'opencode') {
    const text = truncateText(eventText(e.payload));
    return { markdown: text || activityLine(e.payload) };
  }
  if (e.kind === 'error' || e.kind === 'validation-error' || e.kind === 'refinement-error') {
    const msg =
      typeof e.payload === 'object' && e.payload !== null && 'message' in e.payload
        ? String((e.payload as { message: unknown }).message)
        : JSON.stringify(e.payload).slice(0, 200);
    return { markdown: msg };
  }
  if (e.kind === 'validation' || e.kind === 'refinement') {
    return { markdown: validationLabel(e.payload) };
  }
  if (e.kind === 'model') {
    return { plain: modelLabel(e.payload) };
  }
  return { plain: JSON.stringify(e.payload).slice(0, 200) };
}

function FeedPayload({ event }: { event: IssueEvent }) {
  const content = feedContent(event);
  if ('markdown' in content) return <Markdown text={content.markdown} />;
  return <>{content.plain}</>;
}

export interface IssueWorkDetailProps {
  issue: Issue;
  events: IssueEvent[];
  runs: DevelopRun[];
  connected: boolean;
  onMarkShipped: () => void;
  shipping: boolean;
}

export function IssueWorkDetail({ issue, events, runs, onMarkShipped, shipping }: IssueWorkDetailProps) {
  const done = issue.state === 'pr' || issue.state === 'rollout' || issue.state === 'closed';
  const feed = condense(
    events.filter((e) => {
      if (e.kind === 'validation-event' || e.kind === 'refinement-event') return false;
      if (e.kind === 'opencode') return !isNoise(e.payload);
      return true;
    })
  );
  const refinementLatest = [...events].reverse().find((e) => e.kind === 'refinement-event' && !isNoise(e.payload));
  const live = !issue.blockedReason && (issue.state === 'developing' || issue.state === 'refinement');
  const latest = feed.find((e) => e.kind === 'opencode') ?? (live ? refinementLatest : undefined);
  const modelEvent = events.find((e) => e.kind === 'model');
  const latestText = latest ? truncateText(eventText(latest.payload)) : '';

  return (
    <div className="issue-work-detail">
      {runs.length > 0 && (
        <div className="recap-result runs">
          <h3>Run timeline</h3>
          {runs.map((r) => (
            <p key={r.id}>
              <strong>{r.role}</strong> {r.repoOwner}/{r.repoName} — {r.state}
              {r.prUrl && (
                <>
                  {' '}· <a href={r.prUrl}>{r.prUrl}</a>
                </>
              )}
              {r.blockedReason && <> · needs input: {r.blockedReason.slice(0, 200)}</>}
            </p>
          ))}
          {(issue.state === 'pr' || issue.state === 'developing') && (
            <button type="button" className="ghost" disabled={shipping} onClick={onMarkShipped}>
              {shipping ? 'Marking…' : 'Mark shipped'}
            </button>
          )}
        </div>
      )}

      {issue.linkedPrUrl && issue.state !== 'pr' && (
        <div className="recap-result pr">
          <h3>Linked pull request</h3>
          <p>
            PR: <a href={issue.linkedPrUrl}>{issue.linkedPrUrl}</a>
          </p>
        </div>
      )}

      {live && (
        <div className="recap-live">
          <span className="pulse" /> {latest ? activityLine(latest.payload) : 'Starting agent…'}
          {modelEvent && <div className="recap-model">Model: {modelLabel(modelEvent.payload)}</div>}
          {latestText && (
            <div className="recap-snippet">
              <Markdown text={latestText} />
            </div>
          )}
        </div>
      )}

      {issue.blockedReason && (
        <div className="recap-result blocked" role="alert">
          <h3>Needs input</h3>
          <Markdown text={issue.blockedReason} />
        </div>
      )}

      {done && (
        <div className={`recap-result ${issue.state}`}>
          <h3>
            {issue.state === 'pr' ? 'Done — pull request opened' : issue.state === 'rollout' ? 'Done — released' : 'Done — closed'}
          </h3>
          {modelEvent && <p className="recap-model">Model: {modelLabel(modelEvent.payload)}</p>}
          {issue.resultPrUrl && (
            <p>
              <a href={issue.resultPrUrl} target="_blank" rel="noreferrer" title={issue.resultPrUrl}>
                Review it on GitHub ↗
              </a>
            </p>
          )}
          {issue.releaseTag && (
            <p>
              Released in <span className="release-tag">{issue.releaseTag}</span>
            </p>
          )}
          {issue.state === 'closed' && issue.stateReason && (
            <p>
              Closed on GitHub as <span className="release-tag">{issue.stateReason}</span>
            </p>
          )}
        </div>
      )}

      {feed.length > 0 && (
        <details className="issue-work-feed">
          <summary>Activity log ({feed.length})</summary>
          {feed.map((e) => (
            <p key={`${e.id}-${e.ts}`} className={`feed-item ${e.kind}`}>
              <span className="feed-time">{relTime(e.ts)}</span> <FeedPayload event={e} />
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the new file in isolation**

Run: `npm run typecheck`
Expected: no errors (it isn't imported anywhere yet, so this only
catches syntax/type errors within the new file itself).

- [ ] **Step 3: Commit**

```bash
git add src/components/board/issue-work-detail.tsx
git commit -m "feat(board): extract IssueWorkDetail from the issue detail page"
```

---

### Task 7: Wire `IssueWorkDetail` into the topic studio page

**Files:**
- Modify: `src/app/(board)/topics/[id]/page.tsx`

**Interfaces:**
- Consumes: `IssueWorkDetail` (Task 6), existing routes `/api/issues/[id]`
  (returns `{ issue: Issue; events: IssueEvent[] }`) and
  `/api/issues/[id]/runs` (returns `{ runs?: DevelopRun[] }`), existing
  `/api/issues/[id]/mark-shipped` (`POST`, returns `{ issue?: Issue }`).

This is the task with the most judgment: the topic page must fetch
per-issue runs/events **once per linked issue**, and extend its single
existing `EventSource` (line 163) to also carry live `run` and
`opencode-event` messages for those issues — it must not open a second
`EventSource`, and it must not lose the live streaming feel the old page
had (a per-issue polling fallback is not equivalent; `opencode-event`
messages carry data no fetch response does).

- [ ] **Step 1: Add per-issue work state**

Near the existing `const [issues, setIssues] = useState<Issue[]>([]);`
(`topics/[id]/page.tsx:60`), add:

```ts
const [issueEvents, setIssueEvents] = useState<Record<number, IssueEvent[]>>({});
const [issueRuns, setIssueRuns] = useState<Record<number, DevelopRun[]>>({});
const [shippingId, setShippingId] = useState<number | null>(null);
```

(Add `DevelopRun`, `IssueEvent` to the existing `import type { ... } from
'@/lib/types'` at the top of the file.)

- [ ] **Step 2: Fetch runs + events per linked issue after `fetchAll`**

`fetchAll` (line 109-154) already ends with:

```ts
      const issRes = await fetch('/api/issues');
      if (issRes.ok) {
        const issData = (await issRes.json()) as { issues: Issue[] };
        setIssues(issData.issues.filter((i) => i.topicId === topicId));
      }
      await fetchMessages();
```

Change the `if (issRes.ok)` block to also kick off the per-issue fetches,
reusing `issData` rather than re-fetching `/api/issues`:

```ts
      const issRes = await fetch('/api/issues');
      if (issRes.ok) {
        const issData = (await issRes.json()) as { issues: Issue[] };
        const linked = issData.issues.filter((i) => i.topicId === topicId);
        setIssues(linked);
        for (const i of linked) {
          fetch(`/api/issues/${i.id}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { events?: IssueEvent[] } | null) => {
              if (d?.events) setIssueEvents((prev) => ({ ...prev, [i.id]: d.events! }));
            })
            .catch(() => {});
          fetch(`/api/issues/${i.id}/runs`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { runs?: DevelopRun[] } | null) => {
              if (d?.runs) setIssueRuns((prev) => ({ ...prev, [i.id]: d.runs! }));
            })
            .catch(() => {});
        }
      }
      await fetchMessages();
```

- [ ] **Step 3: Extend the SSE handler for live events**

Replace the `onmessage` handler at `topics/[id]/page.tsx:164-176`:

```ts
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (
          (msg.type === 'topic' || msg.type === 'idea-status' || msg.type === 'idea-message') &&
          Number(msg.topicId) === topicId
        ) {
          void fetchAll();
        } else if (msg.type === 'issue' && (msg.issue as Issue).topicId === topicId) void fetchAll();
      } catch {
        // ignore
      }
    };
```

with:

```ts
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (
          (msg.type === 'topic' || msg.type === 'idea-status' || msg.type === 'idea-message') &&
          Number(msg.topicId) === topicId
        ) {
          void fetchAll();
        } else if (msg.type === 'issue' && (msg.issue as Issue).topicId === topicId) {
          void fetchAll();
        } else if (msg.type === 'run' && issues.some((i) => i.id === (msg as { issueId?: number }).issueId)) {
          const issueId = (msg as { issueId: number }).issueId;
          fetch(`/api/issues/${issueId}/runs`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { runs?: DevelopRun[] } | null) => {
              if (d?.runs) setIssueRuns((prev) => ({ ...prev, [issueId]: d.runs! }));
            })
            .catch(() => {});
        } else if (msg.type === 'opencode-event') {
          const m = msg as { issueId: number; event: Record<string, unknown> };
          if (issues.some((i) => i.id === m.issueId)) {
            setIssueEvents((prev) => ({
              ...prev,
              [m.issueId]: [
                { id: 0, issueId: m.issueId, kind: 'opencode', payload: m.event, ts: new Date().toISOString() },
                ...(prev[m.issueId] ?? []),
              ],
            }));
          }
        }
      } catch {
        // ignore
      }
    };
```

(`issues` must be added to the `useEffect`'s dependency array at line
178, alongside the existing `[signedIn, validId, topicId, fetchAll,
fetchMessages]`.)

- [ ] **Step 4: Add the mark-shipped handler**

Near `merge` (`topics/[id]/page.tsx:201-222`), add:

```ts
  const markShipped = useCallback(
    async (issueId: number) => {
      setShippingId(issueId);
      try {
        const res = await fetch(`/api/issues/${issueId}/mark-shipped`, { method: 'POST' });
        const data = (await res.json()) as { issue?: Issue };
        if (data.issue) setIssues((prev) => prev.map((i) => (i.id === issueId ? data.issue! : i)));
      } catch {
        // ignore — the SSE `issue` broadcast will reconcile state if the request landed
      } finally {
        setShippingId(null);
      }
    },
    []
  );
```

- [ ] **Step 5: Render `IssueWorkDetail` in the Work panel**

Replace the work-panel `<li>` body at `topics/[id]/page.tsx:624-650`
(inside the existing `issues.map((i) => { ... })`):

```tsx
                      <li key={i.id} className="released-item">
                        <span className={`dot ${i.state}`} />
                        <a href={i.htmlUrl} target="_blank" rel="noreferrer" className="released-title topic-work-link">
                          {titleMatches ? (
                            <IssueRef issue={i} variant="chip" />
                          ) : (
                            <IssueRef issue={i} />
                          )}
                        </a>
                        {titleMatches && <StatusPill issueState={i.state} />}
                        <span className="topic-work-state">{TOPIC_WORK_STATE[i.state] ?? i.state}</span>
                      {(i.resultPrUrl || i.linkedPrUrl) && (
                        <a
                          className="ghost"
                          href={i.resultPrUrl ?? i.linkedPrUrl ?? ''}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Review PR ↗
                        </a>
                      )}
                      {i.blockedReason && (
                        <div className="topic-work-blocked" role="alert">
                          Needs input: {i.blockedReason}
                        </div>
                      )}
                      <IssueWorkDetail
                        issue={i}
                        events={issueEvents[i.id] ?? []}
                        runs={issueRuns[i.id] ?? []}
                        connected={connected}
                        onMarkShipped={() => void markShipped(i.id)}
                        shipping={shippingId === i.id}
                      />
                    </li>
```

(the title link changes from `Link href={/issues/${i.id}}` to an
external `<a href={i.htmlUrl}>` — Section 3 of the design doc's "view
raw issue on GitHub" rule; this is the work panel's own version of the
same fix Task 5 applied elsewhere. Note this file needs a `connected`
state — check whether `topics/[id]/page.tsx` already tracks SSE
connection status like `issues/[id]/page.tsx` did; if not, add
`const [connected, setConnected] = useState(false);` and set it from
`es.onopen`/`es.onerror` in Step 3's effect, matching
`issues/[id]/page.tsx:144-145`.)

- [ ] **Step 6: Import `IssueWorkDetail`**

Add near the top of `topics/[id]/page.tsx`:

```ts
import { IssueWorkDetail } from '@/components/board/issue-work-detail';
```

- [ ] **Step 7: Fix the `firstBlocked` quick-link**

At `topics/[id]/page.tsx:459`, `<Link href={`/issues/${firstBlocked.id}`}>`
→ external link to `firstBlocked.htmlUrl` (this alert banner's whole
purpose is "an issue needs your input" — sending the user to the
GitHub issue to read the raw blocked-reason context, same pattern as
the work-panel title link above; keep the surrounding text/markup, only
change the link target and tag from `<Link href=...>` to
`<a href={firstBlocked.htmlUrl} target="_blank" rel="noreferrer">`).

- [ ] **Step 8: Typecheck, lint, full test suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

- [ ] **Step 9: Headless smoke check**

Run: `npm run dev &` then, once it's up,
`node scripts/dev/headless-check.mjs --path /topics/1 --expect "Test issue"`
(adjust `--path`/`--expect` to match whatever the dev seed data provides
— check `scripts/dev/seed.mjs` for a real topic id/title to assert on).
Expected: script exits 0, screenshot shows the topic page with the work
panel rendering issue detail inline. Kill the dev server after.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(board)/topics/[id]/page.tsx"
git commit -m "feat(topics): embed issue work detail directly in the studio page"
```

---

### Task 8: Delete the `/issues/[id]` route and do the final sweep

**Files:**
- Delete: `src/app/(board)/issues/[id]/page.tsx` and the now-empty
  `src/app/(board)/issues/[id]/` directory

**Interfaces:** none — this is pure removal, safe only because Tasks 1-7
already moved every consumer off this route.

- [ ] **Step 1: Confirm nothing still references the route**

Run:
```bash
grep -rn '/issues/\${' src/components src/app --include='*.tsx'
grep -rn "from '@/app/(board)/issues" src/
```
Expected: no matches (Task 5's Step 12 already confirmed the `.tsx` link
grep; this re-confirms after Tasks 6-7 touched more files, and adds an
import-reference check).

- [ ] **Step 2: Delete the route**

```bash
git rm "src/app/(board)/issues/[id]/page.tsx"
rmdir "src/app/(board)/issues/[id]" 2>/dev/null || true
```

- [ ] **Step 3: Full verification sweep**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all green, including a successful production build (confirms
no other route/page statically imports the deleted file).

- [ ] **Step 4: Headless smoke check on the board and home**

Run (dev server up as in Task 7 Step 9):
```bash
node scripts/dev/headless-check.mjs --path /
node scripts/dev/headless-check.mjs --path /projects/1
```
Expected: both exit 0. Manually click through: a card in the `ready`/
`realizing`/`rollout` columns opens `/topics/[id]`, not a 404; the
lineage line on a dashboard card (if any linked work exists in seed
data) opens GitHub in a new tab.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(board): delete /issues/[id] — the topic studio is the one work surface now"
```
