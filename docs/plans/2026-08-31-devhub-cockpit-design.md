# DevHub Cockpit — Orchestrator Design

> Status: proposed (2026-08-31). Extend devhub from issue board into a development cockpit
> that orchestrates services, infrastructure, and content across sibling projects.

## 1. What exists today

DevHub is a single Next.js app (`src/`) backed by SQLite (`better-sqlite3`). It:

1. Ingests GitHub issues from `dachrisch` + `bumbleflies` repos via `src/lib/github.ts`
2. Displays them on a Kanban board (`src/app/(board)/page.tsx`)
3. Dispatches opencode sessions via `src/lib/opencode.ts` (create → prompt → poll/stream)
4. The opencode agent on `code.lehel.xyz` implements the issue and opens a PR
5. State flows: `backlog ↔ refinement → developing → pr → rollout` (or `→ blocked`)
6. SSE via `src/lib/sse.ts` streams live updates to the browser

**Infrastructure lives in a separate repo:**
- `/home/cda/dev/infrastructure/container/` — the servyy-container monorepo
- Ansible `docker_service` role deploys any service: template `.env` → `docker compose up -d`
- Two servers: `servy.lehel.xyz` (primary) + `codey.lehel.xyz` (devhub + opencode)
- Deploy pattern: `cd ansible && ./servyy.sh --tags "user.docker.<service>" --limit <host>`

**OpenCode skills** already exist at `infrastructure/container/opencode/skills/`:
- `opencode-deployment/SKILL.md` — deploy/troubleshoot opencode
- `opencode-contribution/SKILL.md` — code changes, testing, PR workflow
- `opencode-dependency/SKILL.md` — coordinate ansible + service changes

## 2. The gap

Right now devhub only does one thing: take a GitHub issue → dispatch opencode → get a PR. The user wants to issue broader commands like:

- "Create service X" → scaffold repo + Dockerfile + ansible + deploy
- "Run campaign for blog post Y" → generate LinkedIn/X content + schedule
- "Add Redis to service Z" → modify docker-compose + deploy
- "Check why service W is slow" → diagnose + fix

All of these follow the same underlying pattern devhub already uses: **build a prompt → dispatch opencode → track outcome**. The difference is what goes into the prompt and what happens after.

## 3. Architecture

```
                        ┌──────────────────────┐
                        │   Command Bar (UI)    │
                        │  POST /api/command    │
                        └──────────┬───────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │   Router (new)        │
                        │   src/lib/router.ts   │
                        │                       │
                        │  classify request     │
                        │  → pick skill         │
                        │  → build prompt       │
                        └──────┬───────┬───────┘
                               │       │
                ┌──────────────┘       └──────────────┐
                ▼                                     ▼
    ┌───────────────────────┐           ┌───────────────────────┐
    │  opencode session     │           │  Direct execution     │
    │  (existing pattern)   │           │  (ansible/API/gh)     │
    │                       │           │                       │
    │  createSession()      │           │  SSH + ansible-playbook│
    │  sendPrompt()         │           │  GitHub API calls     │
    │  pollForFinish()      │           │  docker compose       │
    └───────────┬───────────┘           └───────────┬───────────┘
                │                                     │
                └──────────────┬──────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Knowledge Table     │
                    │  (new, in devhub.db) │
                    │                      │
                    │  log what happened   │
                    │  embed for search    │
                    │  recall next time    │
                    └──────────────────────┘
```

## 4. Concrete changes

### 4.1 New table: `commands`

Tracks every command issued through the cockpit. Added in `src/lib/store.ts`
`migrate()` alongside the existing `issues`, `events`, `auth_sessions`, `settings` tables.

```sql
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request TEXT NOT NULL,              -- raw user input
  intent TEXT NOT NULL,               -- classified: "create_service", "campaign", "develop", etc.
  params TEXT NOT NULL DEFAULT '{}',  -- JSON extracted params
  skill_id TEXT,                      -- which skill handled it (nullable)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failed
  result TEXT,                        -- outcome text
  session_id TEXT,                    -- opencode session ID if applicable
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Functions to add in `store.ts`:
- `appendCommand(request, intent, params)` → returns `CommandRow`
- `setCommandStatus(id, status, result?, durationMs?)` → updates command
- `getCommands(limit?)` → recent commands for history
- `searchCommands(intent?, limit?)` → filtered query

### 4.2 New table: `knowledge`

Stores learned patterns from successful executions. Embeddings via `sqlite-vec`
 extension or a simpler LIKE/FTS approach initially.

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,           -- "service_ops", "campaign", "devflow", "infra"
  summary TEXT NOT NULL,          -- human-readable: "Deployed Go service with Prometheus on servy"
  details TEXT NOT NULL,          -- JSON: full execution trace
  source_command_id INTEGER,     -- FK to commands
  embedding BLOB,                -- vector (phase 2, after sqlite-vec)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(source_command_id) REFERENCES commands(id)
);
```

Functions:
- `storeKnowledge(domain, summary, details, sourceCommandId)` → insert
- `searchKnowledge(query, domain?, limit?)` → semantic search (phase 1: LIKE;
  phase 2: vector cosine similarity)

### 4.3 Router: `src/lib/router.ts`

The router is a **prompt-driven classifier**, not a separate agent. It's a single
opencode session that receives the user's command and returns a structured plan.

```typescript
interface CommandIntent {
  intent: 'create_service' | 'deploy_service' | 'modify_service'
        | 'create_campaign' | 'develop_issue'
        | 'diagnose' | 'unknown';
  confidence: number;
  params: Record<string, unknown>;
  skillId: string;           // which skill file to load
  steps: string[];           // ordered execution steps
}

// The router prompt injects available skills as context:
function buildRouterPrompt(request: string, availableSkills: string[]): string {
  // Lists each skill's name, description, and triggers
  // Asks opencode to classify and return JSON
}
```

Router flow:
1. Fetch skill manifests from `knowledge` table (or hardcoded initially)
2. Build prompt with available skills listed
3. Send to opencode, get back `CommandIntent` JSON
4. If confidence < 0.7 → return clarification question
5. If confidence ≥ 0.7 → execute the plan

### 4.4 Skill files: `src/lib/skills/`

Each skill is a TypeScript module that exports a manifest and execution function.
This mirrors the pattern from `infrastructure/container/opencode/skills/` but
lives inside devhub's codebase.

```
src/lib/skills/
├── index.ts              -- registry, loadAll(), getByIntent()
├── types.ts              -- SkillManifest, SkillContext, SkillResult
├── service-create.ts     -- "Create service X" skill
├── service-deploy.ts     -- "Deploy/redeploy service X" skill
├── service-modify.ts     -- "Add X to service Y" skill
├── campaign.ts           -- "Create campaign for post X" skill
├── develop.ts            -- wraps existing develop flow as a skill
└── diagnose.ts           -- "Why is X broken" skill
```

Each skill file exports:

```typescript
interface SkillManifest {
  id: string;
  name: string;
  description: string;
  domain: string;
  intents: string[];       // triggers: ["create", "new service", "scaffold"]
  requiredParams: string[]; // e.g. ["name"]
  optionalParams: string[]; // e.g. ["framework", "database", "host"]
}

interface SkillContext {
  commandId: number;
  request: string;
  params: Record<string, unknown>;
  token: string;            // GitHub OAuth token
  models: OpencodeModel[];  // resolved model list
  onEvent: (event: OpencodeEvent) => void;
  onStatus: (status: string) => void;
}

interface SkillResult {
  success: boolean;
  summary: string;
  details?: unknown;
  sessionIds?: string[];     // opencode sessions used
}
```

### 4.5 Skill: `service-create.ts` (concrete example)

This is the most complex skill. It orchestrates multiple steps:

```typescript
export async function execute(ctx: SkillContext): Promise<SkillResult> {
  const { params, token } = ctx;
  const name = params.name as string;
  const framework = (params.framework as string) || 'node';
  const host = (params.host as string) || 'servy.lehel.xyz';

  // Step 1: Scaffold repo via opencode
  //   - Creates /home/cda/dev/<name>/ with project structure
  //   - Adds Dockerfile, .gitignore, README, CI workflow
  ctx.onStatus('Scaffolding repo...');
  const scaffoldPrompt = buildScaffoldPrompt(name, framework);
  const scaffoldResult = await runDevelop(scaffoldPrompt, ctx.onEvent, ctx.models);

  // Step 2: Create GitHub repo + push
  //   - Uses `gh repo create dachrisch/<name> --private --source=.` 
  //   - Executed inside opencode session (it has gh CLI)
  ctx.onStatus('Creating GitHub repo...');

  // Step 3: Add to servyy-container
  //   - Creates infrastructure/container/<name>/docker-compose.yml
  //   - Creates ansible/plays/roles/docker_service/templates/<name>/.env.j2
  //   - Adds role invocation to user.yml
  //   - All via opencode session that has access to the infrastructure repo
  ctx.onStatus('Adding to infrastructure...');
  const infraPrompt = buildInfraPrompt(name, framework, host);
  const infraResult = await runDevelop(infraPrompt, ctx.onEvent, ctx.models);

  // Step 4: Deploy via ansible
  //   - SSH into server, git pull, ansible-playbook --tags user.docker.<name>
  ctx.onStatus('Deploying...');
  // This could be a direct SSH call or another opencode session

  // Step 5: Verify health
  ctx.onStatus('Verifying deployment...');
  // Check health endpoint, DNS resolution

  // Step 6: Store knowledge
  storeKnowledge('service_ops',
    `Created ${name} service (${framework}) on ${host}`,
    { name, framework, host, steps: ['scaffold', 'github', 'infra', 'deploy', 'verify'] },
    ctx.commandId
  );

  return { success: true, summary: `Service ${name} deployed at https://${name}.${host.replace('lehel.xyz', '')}` };
}
```

### 4.6 New API routes

```
POST /api/command                    -- submit a cockpit command
GET  /api/command                    -- list recent commands
GET  /api/command/[id]               -- command detail + execution trace
GET  /api/knowledge                  -- search knowledge base
GET  /api/skills                     -- list available skills
POST /api/services                   -- list managed services
POST /api/services/[name]/deploy     -- redeploy a service
POST /api/campaigns                  -- list campaigns
POST /api/campaigns                  -- create campaign (also via /api/command)
```

**`POST /api/command`** — the main entry point:

```typescript
// Request
{ request: string, params?: Record<string, unknown> }

// Response (202 Accepted)
{
  ok: true,
  commandId: 12,
  intent: "create_service",
  status: "running"
}

// Progress via SSE: { type: 'command-update', commandId: 12, status: '...', result: '...' }
```

Implementation:
1. `requireMember(req)` — same auth as existing routes
2. `appendCommand(request, 'pending', {})` — log it
3. Fire-and-forget: `void executeCommand(command)` — same pattern as `startDevelop`
4. Return 202 immediately
5. `executeCommand` calls `router.classify(request)` → picks skill → runs it

### 4.7 Knowledge capture in existing flow

The existing `startDevelop` in `src/lib/develop.ts` already tracks everything.
After a develop completes, also store knowledge:

```typescript
// In startDevelop(), after success:
storeKnowledge('devflow',
  `Developed issue #${issue.number} in ${issue.repo}: ${summary}`,
  { issueId: issue.id, prUrl, model: selectedModel },
  null // no command ID for legacy flow
);
```

### 4.8 UI: Command bar

Add to `src/app/(board)/page.tsx`, above the existing board columns:

```
┌──────────────────────────────────────────────────────────┐
│  [  Type a command... (e.g. "create service my-api")  ]  │
│  Recent: create service X ✓ | deploy Y ✓ | ...          │
└──────────────────────────────────────────────────────────┘
```

- Input field with autocomplete from skill triggers
- Enter submits to `POST /api/command`
- Results appear in the existing SSE event stream
- Command history in a dropdown or side panel

### 4.9 UI: Services section

Add a "Services" tab alongside "Board" and "Recap" in the bottom navigation.
Shows a grid of managed services with status, last deploy, quick actions.

This reads from a `services` table (populated by `service-create` skill and
manual registration):

```sql
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  repo_owner TEXT,
  repo_name TEXT,
  deploy_host TEXT,           -- e.g. "servy.lehel.xyz"
  deploy_dir TEXT,            -- e.g. "infrastructure/container/my-api"
  domain TEXT,                -- e.g. "my-api.lehel.xyz"
  status TEXT DEFAULT 'active',
  last_deploy_at TEXT,
  config TEXT,                -- JSON: framework, ports, env vars
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 5. Concrete example: "Create service blog-api"

```
1. User types: "Create service blog-api with FastAPI and PostgreSQL"
2. POST /api/command { request: "Create service blog-api..." }
3. Router classifies:
   - intent: "create_service"
   - params: { name: "blog-api", framework: "fastapi", database: "postgresql" }
   - skill: "service-create"
   - confidence: 0.95
4. Execute service-create skill:
   a. opencode session 1: scaffold Python/FastAPI project
      - Creates /home/cda/dev/blog-api/
      - main.py, requirements.txt, Dockerfile, .gitignore, README
   b. opencode session 2: create GitHub repo + push
      - gh repo create dachrisch/blog-api --private --source=.
      - git push
   c. opencode session 3: add to servyy-container
      - Creates infrastructure/container/blog-api/docker-compose.yml
        (following devhub's pattern: image, env_file, volumes, networks, traefik labels)
      - Creates infrastructure/container/ansible/plays/roles/docker_service/templates/blog-api/.env.j2
      - Adds role invocation block to ansible/plays/user.yml
   d. Direct execution: deploy via ansible
      - ssh servy.lehel.xyz "cd /home/cda/dev/infrastructure/container && git pull && cd ansible && ./servyy.sh --tags user.docker.blog-api"
   e. Verify: curl https://blog-api.lehel.xyz/health
5. Store knowledge:
   - domain: "service_ops"
   - summary: "Created blog-api (FastAPI + PostgreSQL) on servy.lehel.xyz"
   - details: full trace of what was done
6. SSE broadcasts command status to UI
7. Result: "Service blog-api deployed at https://blog-api.lehel.xyz"
```

## 6. Concrete example: "Create campaign for my blog post"

```
1. User types: "Create campaign for post https://bumbleflies.de/blog/infra-automation"
2. POST /api/command { request: "Create campaign for..." }
3. Router classifies:
   - intent: "create_campaign"
   - params: { url: "https://bumbleflies.de/blog/infra-automation", platforms: ["linkedin", "x"] }
   - skill: "campaign"
   - confidence: 0.9
4. Execute campaign skill:
   a. opencode session: read blog post, generate LinkedIn thread (5-7 posts)
   b. opencode session: generate X/Twitter posts (3-5 tweets)
   c. Store generated content in campaigns table for review
   d. (Future: post via LinkedIn/Twitter APIs)
5. Store knowledge about content patterns
6. Result: "Campaign created with 7 LinkedIn posts and 4 tweets. Review at /campaigns"
```

## 7. What gets built in each phase

### Phase 1: Command infrastructure
**Files to create:**
- `src/lib/router.ts` — classification prompt + intent parser
- `src/lib/skills/types.ts` — SkillManifest, SkillContext, SkillResult types
- `src/lib/skills/index.ts` — skill registry
- `src/app/api/command/route.ts` — POST + GET endpoints
- `src/app/api/command/[id]/route.ts` — detail endpoint

**Files to modify:**
- `src/lib/store.ts` — add `commands` table to `migrate()`, add CRUD functions
- `src/app/(board)/page.tsx` — add command bar input
- `src/lib/sse.ts` — add `CommandEvent` type for SSE broadcasts

**New dependency:** none (router uses existing opencode integration)

### Phase 2: First skill — service-create
**Files to create:**
- `src/lib/skills/service-create.ts` — full skill implementation
- `src/lib/skills/develop.ts` — wraps existing develop flow as a skill
- `src/lib/skills/service-deploy.ts` — redeploy existing service

**Files to modify:**
- `src/lib/develop.ts` — add knowledge capture after completion
- `src/lib/store.ts` — add `knowledge` table

**Integration with servyy-container:**
- The opencode session needs access to `/home/cda/dev/infrastructure/container/`
- It creates docker-compose.yml + .env templates following the existing pattern
- The `docker_service` role in `user.yml` gets a new block for the new service

### Phase 3: Knowledge + recall
**Files to create:**
- `src/lib/knowledge.ts` — embedding + search functions

**Files to modify:**
- `src/lib/router.ts` — inject relevant knowledge into router prompt
- `src/lib/skills/service-create.ts` — recall past patterns before executing

**Dependency:** `sqlite-vec` npm package (C extension for SQLite vector search)

### Phase 4: Campaign skill + services dashboard
**Files to create:**
- `src/lib/skills/campaign.ts` — content generation skill
- `src/app/api/campaigns/route.ts` — CRUD for campaigns
- `src/app/api/services/route.ts` — list services
- `src/app/(board)/services/page.tsx` — services dashboard UI

**Files to modify:**
- `src/lib/store.ts` — add `campaigns`, `services` tables
- `src/app/(board)/page.tsx` — add "Services" tab to bottom nav

### Phase 5: Additional skills
- `src/lib/skills/service-modify.ts` — add Redis, change config, etc.
- `src/lib/skills/diagnose.ts` — troubleshoot service issues

## 8. OpenCode session access to sibling projects

The opencode agent on `code.lehel.xyz` runs in a container with:
- `/root/dev/` mounted (from `openWorkspaceRoot` env var)
- SSH keys for GitHub
- `gh` CLI authenticated

DevHub's `buildDevelopPrompt()` already tells opencode to work in
`WORKSPACE_ROOT/<owner>/<repo>`. For infrastructure changes, the prompt
needs to reference `WORKSPACE_ROOT/infrastructure/container/` instead.

This is a prompt construction concern, not an architecture change. The
`service-create` skill builds prompts that reference both the app repo
and the infrastructure repo paths.

## 9. Constraints

- **No new services** — everything runs inside the existing devhub container
- **No new dependencies** except `sqlite-vec` (phase 3) — router uses existing opencode client
- **Same auth model** — GitHub OAuth, `requireMember()`, session-based
- **Same SSE pattern** — command progress broadcasts via existing `Broadcaster`
- **Same deploy model** — devhub itself deploys via `docker_service` role on codey.lehel.xyz
- **Single-user** — no multi-tenancy, no RBAC, no API keys beyond the existing setup

## 10. Open questions

1. **Ansible execution**: Should devhub SSH into servers directly (needs SSH key in container) or should it always go through opencode sessions that have SSH access?
2. **Skill isolation**: One opencode session per skill step, or one session per entire command? (Current develop uses one session per issue)
3. **Infrastructure repo access**: The opencode container needs `/root/dev/infrastructure/container/` mounted. Is it already, or does this need a volume mount change?
4. **Campaign APIs**: LinkedIn/Twitter API tokens — where do they live? Env vars in the devhub container?
5. **Confirmation gate**: Should destructive operations (deploy to production) require explicit user confirmation, or should they be fully autonomous?
