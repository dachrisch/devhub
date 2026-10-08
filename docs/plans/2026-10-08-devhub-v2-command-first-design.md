# DevHub v2 — Command-first, phone-first design

> Status: validated (2026-10-08). Replaces the board-centric shell of
> `2026-08-30-devhub-design.md`. The engine (opencode driver, store, GitHub
> sync, transitions, auth) is carried over unchanged; the UI and intake are
> rebuilt. Motivation: the v1 board did not match the operator's actual usage —
> freeform intent, phone-first, voice, hand-selectable issues.

## 1. What v2 is

One screen, one input. No columns, no board, no separate intake modes.

- **Work-item cards** (top of page, single column, active items first):
  title, repo, status chip (`refining / developing / pr / rollout / conflict`).
  A **Needs input** banner is promoted to first-class card UI when
  `blocked_reason` is set — answering it from the phone is the primary loop.
- **Bottom dock (fixed, thumb-reachable):** command bar + mic button.
  Freeform text or speech. No repo/stage/issue pre-selection required.
- **Card tap → detail view** (full-screen):
  - Work thread: issue body, live agent progress streams, question-banner
    with reply field (reply resumes the run).
  - Strategy thread: full chat; steering by typing or speaking follow-ups.

## 2. Data model

Existing tables stay as-is (`issues`, `events`, `auth_sessions`). Added:

```
threads:
  id, kind (work | strategy), issue_ids (json), title, state,
  session_id, summary_json, created_at, updated_at
thread_events:
  id, thread_id, kind (user | agent | system), text, ts   -- chat turns
```

`events` continues to hold per-run agent progress (unchanged semantics).
Issue states and transitions are unchanged from #132; no state-meaning is
reused elsewhere. Strategy split-proposals arrive as `{repo, title, body,
why}` records on the last `thread_events` — nothing is auto-created.

## 3. Command resolution

Every bar/mic submission goes through the same pipeline (one opencode call,
model = current refinement model):

1. **Parse intent**: `implement` (one target) | `strategy` (multi-target)
   | `question` (follow-up inside an open thread, no new work).
2. **Shorthand repo mapping**: `XY` → `dachrisch/xy-app` etc., resolved
   against the fetched GitHub repo list. **Never silently guessed** —
   unrecognized → keyword chips; ambiguous → choose-one chips.
3. **Hand-select issues**: only if keyword mapping falls short, e.g.
   difficult kernel or non-channel-specific targets — chips with fuzzy
   title search, never hidden routing.
4. **Create thread & start run**: card appears at top in `refining`
   (work) or `planning` (strategy); context is the thread summary.

Selection prefill: tapping "Command on" (single issue) or "Combine"
(multi-select) prefills the dock with `Implement #132` / the combined
mention — one pathway for all entries, no special cases.

## 4. Strategy thread lifecycle

Example: *"look at the recent tickets in XY and DEF and come up with a
combined implementation strategy."*

1. Parse intent → `strategy` mapping chips confirm repo targets.
2. **Context brief** (automatic): open + recently closed (~30d) issues
   condensed per repo (title/number/one-para gist, not raw bodies).
3. **Planner run** (poll budget ~2× refinement): each turn ends in
   strategy content, follow-up questions, or a split proposal. Streams
   into the detail view like a `developing` run does now.
4. **Chat steering** persists sessions the same way work issues do —
   continue on desktop, answer on phone.
5. **Split proposal** → chips-cards (confirm / drop / edit title inline).
   Nothing is created until confirm. Confirm cap: ≤10 cards per proposal
   (planner is instructed to cap and offer).
6. Confirmed cards become real GitHub issues (topic-tagged so sync
   already finds them) and enter auto-Work: **serial Work queue** (one
   `developing` run at a time; visible queue position on the card).

## 5. Failure modes

- Repo mapping fails → chips, not a guess.
- Planner yields no strategy / no split → thread stays `planning`,
  `blocked_reason` set; reply-from-detail resumes (same pattern as Work).
- Split >10 → cap + offer, by design not by accident.
- `question` intent with no open thread → chip to pick the target work
  item (or new-thread fallback). No silent guessing.

## 6. What's kept, killed, added

**Kept (engine, all existing tests carry over):** `opencode.ts` (driver,
failover chain, poll budgets, SSE proxy), `github.ts` (sync, rollout
sweep, auto-merge), `transitions.ts` (reduced — move buttons die, but
`backlog ⇄ refinement` remains expressible), auth, store, #132 flow.

**Killed:** board grid/columns, batch mode, funnel/burnup, summary
dashboard, taz tiles, per-stage navigation, desktop-specific layout
beyond "renders OK wide".

**Added:** `threads`/`thread_events` tables, resolve/plan library, split
proposal flow, serial work queue, Web Speech API mic (browser-native,
no server audio path — transcript only).

## 7. Testing

- Unit: `resolve` intent/mapping/chips, `plan` split shape, thread state
  machine, serial queue; store migration test for `threads`.
- E2E: extend `scripts/dev/e2e-workflow.mjs` with a strategy-thread
  scenario (mocked planner + mocked GitHub) asserting the chip-confirm
  gate and the serial queue.
- Voice is a transcript-only browser control outside the pipeline; no
  test surface.

## 8. Rollout

In-place replacement, one cut — the v1 shell (board routes and their
tests) is deleted in the same change that ships v2; no dual-mode period.
Schema is additive (`threads`, `thread_events`), so existing data
survives. Follow-up plan doc to be written before implementation starts:
`2026-10-08-devhub-v2-command-first-plan.md`.

## 9. Out of scope (YAGNI)

Notifications/push, board export, desktop-specific polish beyond
responsive sanity, model-picker redesign, project settings UI, offline
PWA.

## 10. Open risk (unchanged from v1)

Auto-approve behavior on `code.lehel.xyz` and WORKSPACE_ROOT visibility
remain unverified. This — not the UI — determines whether v2 feels
hands-off. Verify in the first implementation spike before polishing the
strategy flow.
