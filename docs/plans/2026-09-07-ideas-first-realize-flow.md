# Ideas-first, hands-off Realize flow

> Status: Phase 1 + Phase 2 done on branch `docs/ideas-first-realize-171`
> (2026-09-08). Resolves
> [dachrisch/devhub#171](https://github.com/dachrisch/devhub/issues/171).
> Builds on `2026-09-06-projects-topics-design.md` (Project → Topic → Issue →
> DevelopRun) and `2026-09-02-unify-develop-flow.md` (no blocked state,
> `blocked_reason`, Work resumes). Decisions locked in: **auto-merge when
> green, idea page with chat, link + archive** for duplicates.
>
> - Phase 1 (ideas prominent): home inline idea lists + `topics`
>   status/summary columns + `/topics/[id]` read page + merge/archive +
>   §5.1 status-vocabulary updates. Gate green + full e2e S1–S5 PASS.
> - Phase 2 (shaping loop): `idea_messages` + shape-idea skill/core +
>   messages/choose/ready APIs + chat UI with options + `idea-message` /
>   `idea-status` SSE. Gate green + full e2e S1–S6 PASS (new S6: create idea
>   → 3 options → choose → summary updates → reply → ready).
> - Phase 3 (one-click Realize): `POST /api/topics/[id]/realize` chaining
>   promote → startWork → sweep wait (202 + live `issue`/`run`/`topic` SSE),
>   `realize-idea` router intent + skill, plain-words progress timeline on the
>   idea page, mock-github merge/tag control plane (file-backed steering).
>   Gate green + full e2e S1–S7 PASS (new S7: ready → realize → pr →
>   merge+tag → rollout → shipped → Delivered without opening kanban).
> - Phase 4 (auto-merge when green): `autoMergeAndRelease` worker
>   (checks-green → REST squash merge; protection-blocked → GraphQL
>   `enablePullRequestAutoMerge`; merge conflict / red CI → `blocked_reason`)
>   running on every realize sweep tick, per-project Auto-merge on/off toggle
>   on the project board (`projects.auto_merge`, default on; off = Realize
>   stops at an open PR), manual-mode auto-release per run (never marks a
>   half-merged `both`-scope issue shipped — partial-shipped warning path
>   untouched). Tag names deviate from the sketch on purpose: `devhub-auto-…`
>   instead of `v…` so automated tags can't collide with release-please
>   versions (the sweep accepts any containing tag).
>   Gate green + full e2e S1–S8 PASS (new S8: realize → worker merges + tags
>   with zero steering → rollout → shipped → Delivered; S7 now also covers
>   the toggle off/on + external-merge observation).
>
> Still open (live-verify, carried over): token merge rights, branch
> protection + repo `Allow auto-merge` setting, tag permissions on
> `code.lehel.xyz` + `WORKSPACE_ROOT` visibility — the worker was proven
> against mocks only.

## 1. Vision

A regular user has a project and an idea and wants that idea realized at some
point — without pushing it through the flow themselves. The hub helps in a
non-technical way:

> "My project is P, my idea is XYZ" → hub replies "I see these options…"
> → user picks / rewrites until happy → user says **"Realize it"** → hub
> guides refinement + coding + PR + merge almost without intervention
> (except on failure or a blocking question).

The stage machine `backlog → refinement → developing → pr → rollout →
closed` and the `service/infra/both` scope stay as the hidden "how". The
technical kanban/recap remain as the expert drill-down.

## 2. Current state (what changes)

- `Project 1—* Topic(idea) 1—* Issue 1—* DevelopRun` exists (`src/lib/store.ts`).
- Ideas are second-class: a `topic-chip` filter in the `topics-rail`
  (`src/app/(board)/projects/[id]/page.tsx`), an `N ideas` count + ghost
  `Add idea` on `ProjectsHome` (`src/components/board/projects-home.tsx`).
- Flow needs manual pushes: `Work` button → `POST /api/issues/[id]/develop`
  → `startWork` (`src/lib/develop.ts`); merge + release tag are manual on
  GitHub; `sweepRollouts` (`src/lib/github.ts`) only observes.
- The cockpit composer (`cockpit-composer.tsx` + `src/lib/router.ts` +
  `src/lib/skills/{create-topic,suggest-feature,promote-topic}.ts`) already
  does `topic/suggest/promote` as one-shot commands — there is no
  options loop.

## 3. Concept model

```
Project (plain: "my app/service")
 └─ Idea (prominent card + own page, status: new|shaping|ready|realizing|shipped|dropped)
     ├─ Options thread (hub proposals + user picks/rewrites)
     └─ Realization (auto: GitHub issue + refine + code + PR + merge + release, hidden)
```

- The idea becomes the primary object on Projects home and
  `/projects/[id]` — not a chip filter.
- `Issue/Run/PR` become the hidden execution layer, visible only in an
  expandable "How it was built" section plus the existing kanban/recap.
- Discard/merge ("link and archive"): `dropped` + `merged_into_topic_id` —
  duplicate ideas link to the winner, disappear from active lists but stay
  searchable. There is no `merged` status; a merged idea is `dropped` with
  a pointer to the winner.

## 4. Target UX (non-technical copy, no board jargon)

### 4.1 Projects home `/`

Project cards gain an inline `Ideas (n)` section (top 3 idea titles +
`+ New idea` box) instead of just a count. The Inbox strip stays for
projectless ideas.

### 4.2 New `/topics/[id]` idea page (the chat home)

- Header: idea title, project, plain status
  (`Shaping… / Ready / Realizing… / Delivered / Archived`).
- Main: conversation thread — user message "my idea is XYZ" → hub message
  "I see these options: A / B / C" with one-click `Choose` plus a free-text
  reply box ("…or describe it your way").
- Each hub reply rewrites the shaped idea summary at the top ("So far: …")
  until the user is happy.
- Footer: big `Realize it` button (enabled when `ready` or on explicit user
  confirm) plus quiet `Archive / Merge into…` links. After the click: a
  progress timeline in plain words ("Understanding… / Building… /
  Checking… / Delivered") and a `Needs input` banner only on
  failure/blocking question.
- Mobile: same page, thread-first; board/kanban untouched.

### 4.3 Realize pipeline (fire-and-forget)

One click chains
`promote → refine → develop → CI-green → merge → tag/release → shipped`
with SSE progress. The user intervenes only on `blocked_reason` or failed
checks.

## 5. Data model deltas (`src/lib/store.ts` `migrate()`)

```sql
-- topics: extend; extend the TopicStatus vocabulary
ALTER TABLE topics ADD COLUMN shaped_summary TEXT;
ALTER TABLE topics ADD COLUMN merged_into_topic_id INTEGER NULL
  REFERENCES topics(id) ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN ready_at TEXT NULL;
-- status: new|shaping|ready|realizing|shipped|dropped
-- (migration maps idea→new, active→realizing; `shaping` is reserved for
-- topics with an open thread, so legacy one-shot ideas land on `new`)

CREATE TABLE idea_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- user|assistant|system
  body TEXT NOT NULL,
  options_json TEXT NULL,          -- [{id,title,desc,tradeoff}]
  chosen_option TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`TopicStatus` (`src/lib/types.ts`) and `TOPIC_STATUSES` extend to the six
values above (the const also validates the `GET /api/topics?status=`
filter). `develop_runs` / `issues`: no schema change. `projects` gains
`auto_merge INTEGER NOT NULL DEFAULT 1` (per-project opt-out); `release_mode`
(`tag|manual`) is reused.

### 5.1 Status vocabulary must land everywhere topic statuses are written

Two existing call sites hardcode the old vocabulary and would clobber the
new statuses otherwise:

- `refreshTopicStatus` (`src/lib/store.ts`): with linked issues it only
  ever computes `active | shipped`, and it runs on every sweep/develop
  event (`src/lib/github.ts`) — a `realizing` topic would flip back to
  `active` on the first sweep. New rule: linked issue exists and not all
  settled → `realizing`; all settled → `shipped`; no linked issues →
  leave `new|shaping|ready|dropped` untouched.
- `promote-topic.ts` sets `status: 'active'` on promotion → becomes
  `realizing`.
- `TOPIC_STATUSES` consumers (`GET /api/topics` status filter, topics
  rail, board UI) take the extended enum.

## 6. Backend deltas

### 6.1 Options skill (`src/lib/skills/shape-idea.ts`, new)

Prompt = project config + repo README/open issues + idea thread → returns
`{summary, options[3-5], question}`. Uses the short poll budget like
refinement (`OPENCODE_REFINEMENT_POLL_TIMEOUT_MS`, default 10 min).

### 6.2 Router (`src/lib/router.ts`)

New intents `shape-idea` (free text on the idea page → shaping reply) and
`realize-idea`. Keep the `confidence < 0.5 → failed` rule — never
silent-route to a topic.

### 6.3 APIs (all `export const runtime = 'nodejs'`,
`export const dynamic = 'force-dynamic'`, `requireMember(req)`)

- `POST /api/topics` (extended): creates the topic + first `idea_messages`
  row + fires the first shaping round. **Keeps the current synchronous
  contract** — existing callers (`projects-home.tsx`, project page, cockpit
  `create-topic` skill) expect `{ topic }`; breaking them to return 202 is
  out of scope. Shaping runs fire-and-forget (same pattern as
  `startDevelop`); the idea page learns "options ready" via the
  `idea-message`/`idea-status` SSE events. Only the new idea-page
  endpoints below get async semantics.
- `GET / POST /api/topics/[id]/messages` — thread read + reply (a reply
  triggers the next shaping round).
- `POST /api/topics/[id]/choose` `{optionId}` / `POST .../ready` — record
  the pick / mark shaping done (`ready_at`, status `ready`).
- `POST /api/topics/[id]/realize` — single entry point: `promote-topic`
  (if no linked issue yet) → `startWork` → autonomous chain (§6.4).
  Returns 202 immediately.
- `POST /api/topics/[id]/merge` `{intoId}` — set `merged_into_topic_id`,
  status `dropped`, archive from active lists.

### 6.4 Autonomous chain (`src/lib/develop.ts` + `src/lib/github.ts`)

- Reuse `runRefinement → startDevelop` (per-repo runs + carry-over)
  unchanged; each run is still one session → one repo → one PR with the
  "final message ends in a PR URL" contract.
- New after `pr`: `autoMergeAndRelease(run)` — poll PR checks, then merge
  via the REST API with the session token (the codebase has no `gh` CLI
  dependency and tokens are always passed as arguments, never via env):
  - checks green → `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with
    `merge_method: 'squash'`;
  - branch protection pending → GraphQL `enablePullRequestAutoMerge`
    (the `--auto` equivalent) and let the sweep observe the merge.
  On merge, ensure a tag via the same REST token (`POST
  /repos/{owner}/{repo}/git/tags` + ref creation): for
  `release_mode = 'tag'` create a `v…` tag containing the merge SHA
  so the existing `sweepRunsForIssue` flips `merged → released`; for
  `manual`, take the same Mark-shipped path but auto-clicked when
  `auto_merge = 1`.
- Sweep stays the source of truth for `rollout/shipped`; Realize waits on it
  via the existing SSE `run` events + timeout → `blocked_reason` on CI
  failure / merge conflict.
- Guards: never re-realize a `realizing` topic with a live run (`canDevelop`
  + topic-status check); retry touches only failed runs (idempotent
  `ensureRuns` + carry-over rebuild, per #132 semantics).

## 7. UI copy rules

- User-facing stages: `Shaping / Ready / Realizing / Delivered / Needs
  input`. The kanban keeps its technical names (expert view).
- Every failure surfaces as one plain sentence + one button (`Answer → Work
  resumes`; `See what broke` expands the technical `blocked_reason`).

## 8. SSE additions (`src/lib/sse.ts`)

- `idea-message` (new thread entry / options ready), `idea-status`
  (shaping → ready → realizing → shipped), reuse `issue`/`run` events for
  the hidden execution layer so the timeline updates live.

## 9. Phases

1. **Ideas prominent:** home inline idea lists + `topics` status/summary
   columns + `/topics/[id]` read page + merge/archive. Includes the §5.1
   status-vocabulary updates (`refreshTopicStatus`, `promote-topic`,
   `TOPIC_STATUSES` + migration `idea→new`, `active→realizing`).
   Gate: `typecheck → lint → test → build`.
2. **Shaping loop:** `idea_messages` + shape-idea skill + messages/choose
   APIs + chat UI with options. E2E: create idea → 3 options → choose →
   summary updates.
3. **One-click Realize:** realize API chaining promote → Work → sweep wait +
   progress timeline + plain banners. E2E against
   `mock-github/mock-opencode` (add merge/tag mocks).
4. **Auto-merge when green:** auto-merge worker (REST merge / GraphQL
   auto-merge per §6.4) + per-project toggle + partial-shipped warning
   reuse. Live-verify: token merge rights, branch protection + repo
   `Allow auto-merge` setting, tag permissions on `code.lehel.xyz` +
   `WORKSPACE_ROOT` visibility (existing open items).

## 10. Acceptance

- A regular user never opens the kanban: idea → options → Realize →
  Delivered in ~2 clicks + chat.
- Ideas are listed on home/project pages, each with its thread page;
  duplicates link-and-archive.
- After Realize: PR merged + tag cut without clicks when CI is green;
  `Needs input` + reason only on failure/question; retry resumes the same
  run chain.
- Legacy `result_pr_url` sweep path untouched until the backlog settles.

## 11. Open items / risks

- Auto-approve on `code.lehel.xyz` + `WORKSPACE_ROOT` checkout visibility
  (carried over from AGENTS.md).
- GitHub token merge rights on service + `INFRA_REPO` repos;
  branch protection requires repo-level `Allow auto-merge` + green-check
  requirements for the GraphQL auto-merge path; direct merge needs
  admin-free green checks.
- Options quality is prompt iteration, not schema work — needs live tuning
  against real projects.
