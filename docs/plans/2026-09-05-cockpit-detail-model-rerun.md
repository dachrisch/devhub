# Cockpit: full prompt visibility, model switch, output transcript, rerun

> Status: implemented (2026-09-05). Follows the decided detail-view strategy
> (one shared component, mobile bottom sheet / desktop right drawer).

## Goal

The cockpit (mobile FAB + bottom sheet, desktop trigger pill + expanded input)
is currently fire-and-forget with a one-line truncated status strip. Four
concrete complaints, both mobile and desktop:

1. **The prompt cannot be seen** (mobile especially) — while typing and after
   submitting.
2. **No model switch** — unlike the Work modal, the cockpit always runs the
   default tier chain.
3. **Errors/output truncated** — a failed action shows one ellipsized line in
   the strip; the full `result` is stored but never rendered; the opencode
   event stream is discarded entirely.
4. **No rerun with adjusted prompt** — nothing lets you take a failed action's
   input, tweak it, and resubmit.

Everything needed is already persisted (`actions` table stores `input`,
`params`, `result`, `session_ids`); this is almost entirely client-side UX plus
one small API extension.

## Symptom → root cause (verified in code)

| Symptom | Root cause |
|---|---|
| Mobile prompt hidden while typing | Sheet is bottom-anchored inside a `position: fixed` backdrop (`.cockpit-sheet`, globals.css:2338) with no keyboard handling; the on-screen keyboard covers it. Autofocus makes this immediate. |
| Submitted prompt invisible | Mobile sheet closes and clears input on submit (page.tsx:961, 379); desktop form collapses too (page.tsx:380). The text then lives only in the strip. |
| Prompt/error truncated in strip | `.action-item` is `white-space: nowrap` + ellipsis with `max-width: 460px` (globals.css:800-846); full text only in a `title` tooltip (action-status-strip.tsx:127) — desktop-hover-only, useless on touch. |
| Can't see what the run printed | `executeAction` passes `onEvent: () => {}` twice (api/action/route.ts:73, 101); opencode events from `runDevelop` are dropped. Only terse `onStatus` strings are broadcast. The stored `result` (full summary/reason) is never rendered in full. |
| Toast lost | `actionError` auto-dismisses after 8s (page.tsx:342-346). |
| No model switch | `POST /api/action` accepts only `input`/`params` (api/action/route.ts:23-31); `executeAction` calls `resolveModels()` with no override (route.ts:70). The Work flow already has the full pattern to copy (`/api/models` → `{models, default}`, `ModelPicker` in develop-modal.tsx:78, override persisted server-side via `setDefaultModel` in develop.ts:64). |
| No rerun | No UI renders a stored `input` back into the composer; nothing seeds a new `POST /api/action` from an old row. |

## Plan (4 phases, ordered so each builds on the last)

### Phase 1 — Shared cockpit composer component

Extract the cockpit composer (currently duplicated inline in page.tsx for
mobile sheet + desktop expanded form) into
`src/components/board/cockpit-composer.tsx`, one component rendered in both
shells. It owns:

- **Multiline prompt**: `<textarea>` (2–3 rows, auto-grow to a max) instead of
  `<input>`. Keep `font-size: 16px` on mobile (iOS zoom).
- **Keyboard-safe mobile sheet**:
  - Set `interactive-widget=resizes-content` on the viewport `<meta name>` and
    anchor the sheet with `100dvh`-aware layout so it rides above the
    on-screen keyboard; keep `env(safe-area-inset-bottom)` padding.
  - Fallback (if the meta change isn't enough in practice): focus-driven
    `visualViewport` offset on the sheet.
- **Stay open on submit**: submitting no longer closes the sheet/expanded form
  and no longer clears the text blindly. It clears only on success, and the
  submitted prompt becomes visible as the newest item in the in-composer
  action list (Phase 3). Keep an explicit close (× / backdrop / Escape).
- **State hoisting**: page.tsx passes `input`, `onChange`, `models`,
  `selectedModel`, `onSelectedModelChange`, `onSubmit`, `busy`. Mobile FAB +
  desktop trigger pill keep their current collapse behavior.

### Phase 2 — Model switch

Copy the Work-modal pattern end to end:

- **API**: `POST /api/action` accepts optional `modelId` + `providerID`
  (same body shape as `/api/issues/[id]/develop`). `executeAction` threads it
  into `resolveModels(selectedModel)`; after accepting an override, persist it
  with `setDefaultModel(...)` so it becomes the operator's last-used default
  across cockpit and Work (develop.ts:64 already does this for develop).
- **UI**: composer loads `/api/models` when opened (fetch once, cache in
  page-level state), pre-selects the returned `default`, and renders the
  existing `ModelPicker` from develop-modal.tsx — export it (move to
  `src/components/board/model-picker.tsx`) so both modals share it.
- The strip's `title`/detail shows which model ran (see Phase 3) so past
  actions are auditable.

### Phase 3 — See everything: action detail view + live transcript

- **Capture the event stream**: in `executeAction`, replace both no-op
  `onEvent`s with a per-action ring buffer (bounded, e.g. last 100 events /
  32 KB, formatted one line each). Drain it in three directions:
  1. **Live**: throttled SSE — piggyback formatted lines onto
     `publishAction(id, 'running', detail)` (throttle to ~1/s, keep the terse
     status line as the last entry).
  2. **Persistent**: on terminal status, append the buffer to the row
     (new `transcript` column on `actions`, nullable text; include in
     `getAction`/`getActions` API shape — strip it from the list endpoint's
     payload, serve it only from `GET /api/action/[id]`).
  3. **Session links**: `session_ids` already stored — render each as an
     "Open opencode session" link in the detail view.
- **Detail view** (`src/components/board/action-detail.tsx`) — **decided
  strategy: one shared component, breakpoint-adaptive shell, CSS-only
  difference**:
  - **Mobile: near-full-height bottom sheet** (`height: min(90dvh, …)`,
    rounded top, drag-handle), reusing the cockpit-sheet shell pattern.
  - **Desktop: right-side drawer** (fixed, `width: min(460px, 40vw)`, full
    height, border-left) — not a centered modal. Rationale: reading long
    errors/transcripts wants width + height and should not block the board;
    with Phase 4 the drawer can stay open and follow the rerun live.
  - **Readability requirements (both shells):**
    - Full text, never truncated: `white-space: pre-wrap`,
      `overflow-wrap: anywhere` (long URLs/PR links/hashes must break).
    - Transcript + result in monospace, inside a scrollable region
      (`max-height` bounded, internal scroll) so the shell never grows past
      the viewport.
    - Stick-to-bottom while running: auto-scroll follows new lines unless the
      user scrolled up.
    - "Copy" button next to input and result (mobile has no select-all
      affordance; copy is how the error gets reused).
    - Wrapped input, status + duration + model used, collapsible transcript,
      session links ("Open opencode session"), Phase 4 rerun button.
  - **Late-joiner data**: the ring buffer is flushed to the `transcript`
    column on every throttled publish (~1/s), not only on finish — then
    `GET /api/action/[id]` always returns the transcript-so-far, so a client
    that opens the detail mid-run (or reloads the page) sees everything, not
    just SSE lines that arrived after opening. The sheet renders stored
    transcript + appends live SSE lines after that point.
- **Strip stays a strip** but stops losing data: failed items still show the
  ellipsized one-liner, but the whole item becomes a button with an explicit
  affordance (chevron), and the error toast (`actionError`) gets a
  "Details" action that opens the newest failed action's detail view.

### Phase 4 — Rerun with adjusted prompt

In the detail view: **"Rerun"** button (terminal-status actions only).

- Opens the cockpit composer prefilled with the action's original `input`
  (fully editable), the model override it ran with pre-selected, and a
  `retryOf` marker kept client-side (included as `params.retryOf = <id>` so
  the new row records lineage without new schema).
- Submits via the normal `POST /api/action` — a new action row; the old one is
  untouched (history stays honest, no server rerun endpoint needed).
- The detail view stays open and follows the new action live (switches to the
  returned `actionId`), so on desktop the drawer becomes a live run monitor
  next to the board; on mobile the sheet shows the same streaming view.
- The composer itself reopens on top (mobile FAB sheet with keyboard up;
  desktop expanded pill form) for editing, both exist post-Phase 1.

## Implementation notes (by file)

| File | Change |
|---|---|
| `src/components/board/cockpit-composer.tsx` | **new** — shared composer (Phase 1) |
| `src/components/board/model-picker.tsx` | **new** — `ModelPicker` moved out of develop-modal.tsx, exported |
| `src/components/board/develop-modal.tsx` | import ModelPicker from its new module (no behavior change) |
| `src/components/board/action-detail.tsx` | **new** — detail view (Phase 3) + rerun (Phase 4); shared component, bottom-sheet shell on mobile / right-drawer shell on desktop |
| `src/app/(board)/page.tsx` | replace both inline cockpit forms with the composer; hoist model state; wire detail view + `actionError` "Details"; stop closing/clearing on submit |
| `src/app/api/action/route.ts` | accept `modelId`/`providerID`; `resolveModels(selected)`; `setDefaultModel` on override; real `onEvent` → ring buffer + throttled publish + transcript flush (~1/s) |
| `src/lib/store.ts` | `transcript` column (CREATE TABLE IF NOT EXISTS migration via ALTER-if-missing pattern used elsewhere); `setActionTranscript(id, text)`; include in `getAction` only |
| `src/lib/sse.ts` | no schema change — reuse `publishAction` |
| `src/app/layout.tsx` | viewport meta: `interactive-widget=resizes-content` (Phase 1) |
| `globals.css` | textarea styles; keyboard-safe `.cockpit-sheet` (dvh); strip item-as-button affordance; detail shells (`.action-sheet` mobile dvh bottom sheet, `.action-drawer` desktop right panel); pre-wrap/monospace transcript block; copy + stick-to-bottom behavior styles |

## Tests

- `src/lib/router.test.ts` unaffected. Add:
  - store: `transcript` round-trip + list endpoint excludes it.
  - api/action: override accepted (`resolveModels` heads the chain — mirror
    opencode.test.ts:274) and `setDefaultModel` persisted.
  - `cockpit-composer`: keep-open + prefill-on-rerun behavior (vitest,
    following existing component tests if any — otherwise board-ui-style pure
    helpers for the prefill logic).
- Manual/headless: use the `headless-dev` skill (mocked GitHub/opencode) —
  open cockpit on mobile viewport (CDP device metrics, 390×844), type a long
  prompt, verify keyboard overlay via screenshots; submit, open detail sheet
  from strip, verify full error + transcript; rerun prefilled; verify model
  switcher lists mocked models and override sticks across reload.

## Verification order

`npm run typecheck` → `npm run lint` → `npm test` → `npm run build`
(remember: extensionless relative imports only; TS and eslint stay pinned).

## Open questions

1. Transcript bound size — 32 KB enough? `fix` runs can be chatty.
2. Does `interactive-widget=resizes-content` suffice on iOS Safari, or do we
   also need the `visualViewport` fallback? Verify on a real device before
   dropping the fallback.
