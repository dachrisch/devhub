# Details card v3 — unified, styled, navigable

Date: 2026-10-08. Follows `2026-10-08-devhub-v2-command-first-design.md`.

## Problems (v2)

- Card checkboxes + Combine bar duplicate what the dock already solves: typing
  multiple mentions ("strategy for A#1 and B#2") goes through the same resolve
  pipeline. Checkboxes are removed; combined strategy is typed, not assembled.
- `IssueDetail` renders `body` as a `white-space: pre-wrap` paragraph — raw
  `##` headings, fenced blocks, `-` bullets all print literally.
  `src/lib/markdown.ts` has a dependency-free parser but no renderer (the old
  renderer was deleted with the v1 board).
- `IssueDetail` never shows history, even though `GET /api/issues/[id]`
  already returns `{ issue, events }` (state changes, run events, recovery).
- Detail overlay is `position: fixed; inset: 0` — it covers the appbar
  (Refresh, user, connection), leaving only a "← Back" ghost button.
- GitHub/PR links are plain text links; Work CTA sits in the dock area at the
  bottom-left, disconnected from the detail it belongs to.
- Detail is not reachable by browser back / refresh; no `?card=` state.

## Design

### One detail shell, two content flavors

`IssueDetail` and `ThreadDetail` keep their IDs/props but share a new
`DetailShell` (`src/components/threads/detail-shell.tsx`):

- Overlay panel, **not** full-screen: dimmed backdrop over the whole page,
  detail column max 560px centered. The appbar stays mounted and visible
  (no `inset: 0` z-modal take-over of the header zone).
- Close affordances: `← Back` button, Escape key, backdrop click.
- `?card=` navigation: `openCard` in `page.tsx` does
  `history.pushState(null, '', '?card=<key>-<id>')`; a `popstate` listener +
  initial-mount hydration keep the detail open across refresh and back-gesture.
  Both views close cleanly and follow the same state.

### Issue detail content (unified flavor)

1. Repo/number line: `owner/repo#123 · synced <relative time>`.
2. Title, 16px/600.
3. Needs-input banner first-class under the title when `blockedReason`.
4. Body rendered by new `MarkdownBody` (`src/components/threads/markdown-body.tsx`)
   wrapped over `parseMarkdown`/`parseInline` from `src/lib/markdown.ts`:
   headings, lists, fenced code (mono 13.5px, `--panel-2` bg), inline code
   chips, bold/links. Unparseable content falls back to a pre-wrapped
   paragraph. No new npm dependencies.
5. `resultText` rendered as a second markdown block, labeled "Last result".
6. Activity timeline: collapsible `<details>` (default open when blocked),
   one tinted row per event from `/api/issues/[id]` — relative timestamp +
   kind-colored dot, payload text truncated to ~200 chars.
7. Links as chip-style buttons: `GitHub ↗`, `Pull request ↗` — brand accent,
   hover ring; not plain text.
8. Work CTA: full-width primary button pinned inside the detail column
   ("Work on this" → "Starting…" → opens the created thread). Hidden for
   `pr/rollout/closed` with a read-only note. The old floating
   "Work on this" in the dock corner is removed.

### Thread detail content

Same shell (backdrop, appbar visible, Escape, `?card=`). Chat events, split
proposal chips and the reply input are unchanged in behavior; the reply input
rows style matching the shared shell instead of a duplicated one.

## Out of scope

- No new API endpoints (history/data already present on the client payloads).
- No multi-select/Combine replacement: dock typing is the path.
- No markdown editor.

## Verification

`typecheck → lint → test → build`, then headless e2e
(`scripts/dev/start-dev.mjs` + `scripts/dev/e2e-workflow.mjs`) asserting the
detail renders markdown headings (no literal `##`) and closes on Escape/back.
