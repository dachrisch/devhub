# Projects & Topics cockpit

> Status: design (2026-09-06), Phase 1 in progress on branch
> `feat/projects-topics`. Resolves
> [dachrisch/devhub#167](https://github.com/dachrisch/devhub/issues/167).
> Reorganizes the dashboard around projects and topics; supersedes the board
> sections of `2026-08-30-devhub-design.md`. Flow rules from
> `2026-09-02-unify-develop-flow.md` (no blocked state, blocked_reason, Work
> resumes) are reused unchanged and extended to per-repo runs.

## Implementation status

Phase 1 (data layer) — done on this branch:

- `store.ts`: `projects`/`topics`/`develop_runs` tables; issues gain
  `project_id`/`topic_id`/`repo_scope`/`infra_first`; migration seeds projects
  from `services` and auto-assigns every issue (repo → project, skeleton
  project auto-created per unknown repo, `Unsorted` last resort); CRUD for
  projects/topics/runs + `assignIssue`/`setIssueScope`; `upsertIssue` returns
  the row.
- `project-status.ts`: derived status + card summary (in-flight counts,
  needs-input, ideas).
- APIs: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/[id]`,
  `GET/POST /api/topics`, `GET/PATCH/DELETE /api/topics/[id]`,
  `POST /api/issues/[id]/assign` (metadata-only; stage moves untouched).
- Ingest: `refreshIssues` resolves repo → project per issue.
- `INFRA_REPO` env (`owner/name`) in `env.ts` + `.env.example`.
- Gate green: typecheck, lint (0 errors), full vitest suite.

Phase 1 remainder (done on this branch): `launch.ts` registers into the
projects table (upsert by name); `GET /api/services` is a legacy compat
endpoint sourced from projects; store tests cover migration seed,
repo→project assignment, skeleton auto-create, project CRUD + delete guard,
topic lifecycle + refresh, scope + idempotent run plans.

Phase 2 (in progress on this branch): Projects home section live on `/`
above the flat board — `ProjectsHome` (`src/components/board/projects-home.tsx`)
renders status badges, last-shipped, in-flight/pr/idea counts, needs-input,
repo chips, per-card Add idea, `+ new project`, and the Inbox strip with
one-click assign; selecting a card scopes the kanban (columns, counts, repo
chips, Ctrl+A) via `issue.projectId`, with a filter banner to clear.
Verified live against mocked GitHub (headless PASS + API smoke: idea, assign,
create, services-compat).

Also on this branch:

- SSE `project`/`topic`/`run` id-notifications (`sse.ts` + publish on
  project/topic CRUD, issue assign; the home re-fetches on them).
- Kanban extracted into shared components (`issue-card.tsx`,
  `kanban-board.tsx`, `board-toolbar.tsx`, `released-strips.tsx`;
  `runSupersededByBroadcast`/`notifyStateChange`/`KANBAN_COLUMNS` live in
  `board-ui.ts`) — reused by both boards.
- `/projects/[id]` board route: header (back, name, status badge, search,
  live dot), topics rail (idea/active/shipped chips filter the kanban,
  inline Add idea), kanban via `KanbanBoard`, batch ops + shortcuts scoped,
  SSE-scoped updates. `headless-check.mjs` gains `--path` to verify
  sub-routes (project board + topic chip PASS).
- Recap breadcrumb: project / topic crumbs above the feed, fetched
  best-effort from `/api/projects/[id]` + `/api/topics/[id]`.

Phase 2 (done on this branch): `/` is projects-first — project cards + inbox
+ global search with jump (repo:/title:/owner:/state:/body:/number: syntax,
links to the project board and recap); the flat kanban is removed (kanban
only under `/projects/[id]`); mobile home stacks full-width cards; `run` SSE
events are published on every run transition and re-fetch the project board.

## Goal

The cockpit is organized around **services**, not tickets:

- **Project** = a running service. Status is *earned* from the last features
  deployed, not typed.
- **Topic** = a feature idea, native to DevHub. Entered via the global input or
  machine-suggested from a project ("next suggested feature"). Cheap to
  accumulate; becomes a real GitHub issue only when promoted.
- **Context-aware work**: a feature that spans the project's service repo and
  the shared infra repo runs as **sequential per-repo child runs**, producing
  one PR per repo under one work item, tracked run by run.

The flat all-issues board is removed; the kanban becomes a per-project
drill-down. `/issues/[id]` recap stays.

## Concept model

```
Project (a live service)
   │ 1
   ├─* Topic (idea bucket; projectless topics sit in the Inbox)
   │      │ 1
   │      └─* Issue (work pipeline, GitHub-backed — states unchanged)
   │               │ 1
   │               └─* DevelopRun (one session → one repo → one PR)
   │
   └─ refs: service repo (owner/name) + shared INFRA_REPO + per-project infra_dir
```

One "feature that shipped" = a Topic, realized by ≥1 Issue, executed as ≥1
DevelopRun (PRs), aggregated upward: PRs → run states → issue state → topic
status → project badge.

## Schema

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  service_repo_owner TEXT, service_repo_name TEXT,
  domain TEXT, deploy_host TEXT, deploy_dir TEXT, infra_dir TEXT,
  status TEXT,                     -- derived, cached
  status_override TEXT,            -- manual, always wins
  last_shipped_at TEXT, last_shipped_title TEXT,
  release_mode TEXT NOT NULL DEFAULT 'tag',   -- 'tag' | 'manual'
  config TEXT NOT NULL DEFAULT '{}',          -- project context injected into prompts
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  area TEXT, title TEXT NOT NULL, notes TEXT,
  status TEXT NOT NULL DEFAULT 'idea',        -- idea|active|shipped|dropped
  origin TEXT NOT NULL DEFAULT 'manual',      -- manual|suggested
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- issues: ALTER TABLE add project_id INTEGER NOT NULL (after migration fill),
--         topic_id INTEGER NULL.

CREATE TABLE develop_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,                          -- 'service' | 'infra'
  repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',       -- pending|developing|pr|failed|merged|released
  session_id TEXT, pr_url TEXT, result_text TEXT, blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Legacy single-PR columns (`result_pr_url`, `linked_pr_url`, `release_tag`) stay
read for pre-migration issues; run-based issues ignore them.

## State machines

```
Topic:    idea ──promote──▶ active ──all linked issues settled──▶ shipped
            └─▶ dropped                                       (rollout|closed)

Run:      pending ─▶ developing ─▶ pr ─▶ merged ─▶ released
                          └─▶ failed (blocked_reason names repo; retry → developing)
          manual "Mark shipped" on pr|merged → released (always allowed, wins over sweep)

Issue:    backlog → refinement → developing → pr → rollout → closed (unchanged;
          sweep is per-run; issue reaches rollout only when ALL runs released)

Project:  status_override                         ← always wins
          in-flight   (any run developing|pr, not blocked)
          needs-input badge counts runs blocked (developing + blocked_reason)
          healthy     (no active work; last_shipped_at ≤ 14d)
          stale       (everything else)
```

## UI

### `/` — Projects home

- Header: global composer (unchanged), live SSE dot, ActionStatusStrip.
- **Project cards grid**: name, domain, status badge (with ⚠ n needs-input),
  last shipped feature + tag/date, in-flight counts (`n dev · n pr`), idea
  count, repo chips (service + shared infra), actions: *Add idea*,
  *Suggest next*, *Board →*.
- **Inbox strip**: projectless topic ideas; assign to a project (and area) in
  one click.
- *+ new project* card (name + service repo; rest editable later).
- Mobile: cards stack vertically; composer stays the FAB/bottom sheet.

### `/projects/[id]` — project board

- Header: back link, status, *Add idea*, *Suggest next*, *Refresh*.
- **Topics rail**: ideas / active / shipped (dropped hidden behind a filter),
  click to filter the kanban.
- **Kanban**: the existing four columns + recently shipped/closed strips,
  scoped to the project's issues. Cards gain: topic tag, scope badge
  (`svc`/`infra`/`both`), per-run **PR chips** with live state
  (`gallery #61 ●pr`, `infra #88 ●dev`), per-run needs-input banners, and the
  **partial-shipped warning** ("service live, infra pending") when runs are in
  mixed terminal states.
- Batch ops and keyboard shortcuts keep working, scoped to the project board.
- Search in the header becomes **global** (across projects/issues; `repo:` /
  `title:` filters keep working) and jumps to the project board or recap page.

### `/issues/[id]` — recap

Unchanged feed plus a **run timeline** section (per-run state, PR link,
blocked reasons). Project + topic breadcrumb added.

## Orchestration

### Refinement (extended, one contract addition)

`buildRefinePrompt` output gains two fields alongside
`ready|improvedBody|blockingQuestions`:

- `scope`: `service` | `infra` | `both`
- `infra_first`: boolean (run order when scope = `both`)

Persisted on the issue (`repo_scope`, `run_order`). Not-ready → blocked_reason
as today, card stays.

### Develop (child runs)

`startDevelop` translates scope into a run plan and executes **sequentially**:

1. Create/refresh the issue's `develop_runs` rows (`pending`) for the planned
   repos, roles, and order (seq).
2. For each run in order: `state = developing`, prompt built by
   `buildDevelopPrompt(issue, run, carryOver)` — per-repo repo path
   (`WORKSPACE_ROOT/<owner>/<repo>`), branch
   `devhub/p<projectId>-i<issue#>-<role>`, worktree per run. When a previous
   run in the chain produced a PR, its **URL + summary are injected as
   carry-over context** into the next prompt (works in both orders).
3. Run result: PR URL → `pr`; `ALREADY RESOLVED`/closed → run `released` via
   the closed path; failure → run `failed` + issue `blocked_reason` naming the
   repo (`infra: CANNOT FULFILL: …`) → chain stops, card stays `developing`.
4. All runs have PRs → issue `pr`.

Key contract win: each run is still **one session → one repo → one PR**;
`runDevelop`, `extractPrUrl`, and the "final message ends in a PR URL" rule are
unchanged.

**Retry** (Work click on developing + blocked): only `failed` (and missing)
runs are re-run; runs already `pr`/`merged`/`released` are skipped; carry-over
rebuilds from whatever runs exist so far. Issue state and per-run reasons
mirror the #132 semantics.

### Sweep (`sweepRollouts`)

Per **run** in `pr`: GitHub PR merged + release tag containing the merge
commit → `merged` → `released` (respecting `release_mode`; `manual` projects
only advance via Mark shipped). When all of an issue's runs are `released` →
issue `rollout` (`setRollout`), topic → `shipped` when all its issues settled,
project `last_shipped_at/title` cache update + badge recompute.

**Legacy dual path**: issues without `develop_runs` keep the existing
single-PR sweep logic (their `result_pr_url`/`release_tag`) until the legacy
backlog settles; isolated behind a "has runs?" branch. Cleanup milestone
tracked in this doc's checklist.

### Partial-shipped warning

If an issue's runs are in mixed terminal states (some `released`, some
`pr|developing`), the card and project card show *partial: service live, infra
pending* — surfaces the half-deployed risk instead of hiding it.

## Cockpit (global input)

- Router actions extended: `topic` (create an idea), `suggest` (propose the
  next feature for a named project), `promote` (topic → GitHub issue).
- New skills: `create-topic`, `suggest-feature` (reuses refinement machinery;
  feeds README/open issues/recent releases), `promote-topic` (wraps
  `createGithubIssue` + upsert + topic link; assumed always-issue, keeps the
  label/comment mirror).
- **No silent rerouting**: low-confidence input stays `failed` +
  `learnUnknown`; the failed-action UI offers a one-click **"save as idea"**.
- Project config (repos, deploy info) + runbook entries (`knowledge.ts`) are
  injected into refine/develop/promote prompts — the work-context layer.

## Project status derivation

`project-status.ts` — derive on SSE-relevant changes and refresh:

1. `override` wins.
2. any run `developing|pr` and not blocked → `in-flight`.
3. else `last_shipped_at` ≤ 14d → `healthy`.
4. else `stale`.

Cached on the project row; badge recompute triggered by sweep/refresh/run
transitions. Optional GitHub latest-release poll (service repo) updates
`last_shipped_*` for manual deploys.

## Migration

1. Create `projects`, `topics`, `develop_runs`; add `issues.project_id`,
   `issues.topic_id`, `issues.repo_scope`, `issues.run_order`.
2. Seed `projects` from existing `services` rows (name, service repo, deploy
   host/dir, domain, config).
3. Auto-assign every issue: repo → matching project; repos with no match
   **auto-create a skeleton project** (name = repo, service repo prefilled) on
   first sight — at migration and on every ingest.
4. Leftovers (no repo resolution possible) → synthetic **Unsorted** project.
5. Legacy `result_pr_url` issues keep working via the legacy sweep path.

**Project delete** rule: blocked while issues reference it; reassign first
(UI hints the count).

## Prerequisites (deployment)

- `INFRA_REPO=owner/name` env (shared infra repo).
- Infra repo checked out at `WORKSPACE_ROOT/<owner>/<repo>` on the devhub host
  — same live-verification caveat as AGENTS.md's open item, now covering both
  repos.
- GitHub token has PR rights on the shared infra repo.
- Auto-approve behavior on `code.lehel.xyz` still unverified (AGENTS.md).

## Phases

1. Schema + migration + store fns/types + APIs (`/api/projects`,
   `/api/topics`, `/api/topics/[id]`, assignment) + repo→project resolution in
   ingest + launch.ts switch. ✅ done
2. UI: Projects home + `/projects/[id]` (kanban moves into
   `src/components/board/`), topics rail, inbox, SSE `topic`/`project`/`run`
   events, remove flat board, global search, mobile home. ✅ done
3. Orchestration: refinement scope/order, child-run sequencing + carry-over,
   per-run sweep + legacy dual path, Mark shipped. ✅ done
   (`planRunsForIssue`, sequential `runSingleChildRun` with carry-over,
   `sweepRunsForIssue` + legacy path, `POST /mark-shipped`,
   `GET /runs`, run timeline on recap, PR chips + scope badge + partial
   warning on cards)
4. Cockpit: router actions + skills + context injection + "save as idea". ✅
   done (`topic`/`suggest`/`promote` actions, `create-topic`/`suggest-feature`
   /`promote-topic` skills, `POST /api/topics/[id]/promote`,
   `POST /api/action/[id]/save-idea`, project config injected into refine
   prompts)
5. Status derivation + suggest-feature button + badges. ✅ done
   (`summarizeProject` on `GET /api/projects`, `last_shipped_*` on rollout,
   `POST /api/projects/[id]/suggest` + Suggest next button)
6. Tests + e2e: migration/seed/assignment tests, child-run retry/sweep tests,
   two-repo mocks in `scripts/dev/mock-github.cjs`, e2e flow idea → promote →
   two-PR run → rollout → badge flip. ✅ done (S5 in `e2e-workflow.mjs`;
   mock-github handles promote issue creation; mock-opencode refine replies
   carry scope fields)

Gate per phase: `typecheck → lint → test → build`.

## Gaps addressed (from the design review)

1. **Legacy dual-path sweep** — explicit, isolated "has runs?" branch; cleanup
   milestone.
2. **Infra "released" undefined for config-only changes** — `release_mode`
   (`tag|manual`) per project + manual *Mark shipped* that always wins.
3. **Scope enum + order** — `service|infra|both` and `infra_first`, decided in
   refinement; carry-over works in both directions.
4. **Unknown repos on ingest** — auto-create skeleton projects; Unsorted only
   as last resort.
5. **No silent free-text → topic** — explicit `topic` action; failed actions
   offer "save as idea".
6. **Blocked runs poison project status** — needs-input badge; `in-flight`
   counts only non-blocked runs.
7. **Branch naming** — stable `p<projectId>` prefix, rename-safe.
8. **Partial-shipped visibility** — warning on card + project card.
9. **Deployment prerequisites** — infra checkout + token scope documented
   above.
10. **Lost flat-board affordances** — batch ops scoped to project board;
    global search with jump; project-delete rule; mobile home layout.

## Acceptance

- Home shows project cards with earned status + last shipped feature; inbox
  catches projectless ideas; unknown-repo ingest auto-creates a project.
- One Work click on a `both`-scoped feature yields two aligned PRs in the
  chosen order; card shows per-run PR chips; rollout only after both runs
  released (or Mark shipped).
- Failed run leaves the card in `developing` with a repo-named
  `blocked_reason`; retry touches only that run.
- Free text never silently becomes a topic; the failed-action "save as idea"
  affordance does.
- No flat board; global search still finds any issue.

## Open items

- Real `INFRA_REPO` value (unset → `both`/`infra` scopes fall back to
  service-only with no error; set `INFRA_REPO=owner/name` to enable two-PR
  runs).
- Promote always creates a GitHub issue (keeps the label/comment mirror).
- Verify live: infra repo checkout visibility + auto-approve on
  `code.lehel.xyz`.
