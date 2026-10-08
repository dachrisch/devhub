# v2 UI polish round 1 — design record

> Status: shipped (2026-10-08). Fixes for the first real feedback round after
> the v2 command-first cut (`2026-10-08-devhub-v2-command-first-design.md`).
> No engine changes; UI + one reconcile guard.

## Symptoms → causes (all verified in code)

| # | symptom | root cause |
|---|---|---|
| 1 | cards missing margins (inside) | `.v2-card` rows had no horizontal padding; the Needs-input banner's red border and the buttons sat flush on the card edge; legacy `.card{margin:10px}` also doubled with the flex gap |
| 2 | "Command on" unclear | button only did `setCommand(mention)` — no focus, no submit, label said nothing |
| 3 | card click dead | `onOpen` no-oped when `threadId == null`; no issue detail view existed |
| 4 | mobile header strange | the 768px block stacked `.app-head` into two rows (brand name hidden, controls full-width) |
| 5 | Refresh appeared broken | the button only re-read SQLite (two GETs); `POST /api/issues` (`refreshIssues`) was never called from the UI; zero feedback |
| 6 | rollout cards stuck open | `RECONCILE_STATES` excluded `rollout`, so GitHub-closed rollout cards never flipped to `closed` |

## Decisions

- **Card click = read, dock = act.** Cards without a thread open the new
  issue-only `IssueDetail` (reuses the `v2-detail` shell; "Work on this"
  there submits the implement mention — hidden for `pr/rollout/closed`).
  Thread cards keep opening `ThreadDetail`.
- **"Command on" → "Work on this"**, prefill + focus the dock (`inputRef`
  on `CommandDock`); sending stays a manual press. The Combine bar also
  focuses the dock now.
- **Refresh = real sync.** Button runs `POST /api/issues` (ingest + rollout
  sweep + reconcile with the session token), then refetches; busy state +
  count notice (`repos/issues/rolledOut/closed`) + error banner, self-clearing.
- **`rollout` joins `RECONCILE_STATES`.** A rollout card whose GitHub issue
  is already closed (manual close, or merged before the tag sweep) flips to
  `closed` on refresh; its result PR/tag history stays in the row.
- **Closed cards drain out.** `closed`/`done` cards leave the main list for
  a collapsed "N recently closed" strip (<details>, dimmed, tap reopens the
  detail; state reason shown as "not planned"/"completed").
- **Mobile header = one compact row**: keep a small brand name, dot-only
  connection pill (text wrapped in `.conn-text`, hidden ≤768px), compact
  Refresh; no more sparse full-width control strip.

## Files

- `src/components/threads/issue-detail.tsx` — new issue-only detail view.
- `src/app/(board)/page.tsx` — dock ref + focus, sync handler + notices,
  `detailIssueId` state, closed-strip partition, onOpen branching.
- `src/components/threads/command-dock.tsx` — optional `inputRef`.
- `src/components/threads/work-card.tsx` — label rename, `note` field
  (state reason for the closed strip).
- `src/components/app-header.tsx` — connection text wrapped for hiding.
- `src/app/globals.css` — v2 card padding, closed strip, detail actions,
  mobile header block.
- `src/lib/github.ts` + `github.test.ts` — `rollout` reconcile + test.

## Out of scope (deliberate)

Queue-position badge wiring (still hardcoded `null`), auto-sync on page
load (GitHub rate limits; sync stays manual), audio/feedback cues.
