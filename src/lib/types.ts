export type IssueState = 'backlog' | 'refinement' | 'developing' | 'pr' | 'rollout' | 'closed';

export const ISSUE_STATES: readonly IssueState[] = [
  'backlog',
  'refinement',
  'developing',
  'pr',
  'rollout',
  'closed',
];

export function isIssueState(value: unknown): value is IssueState {
  return typeof value === 'string' && (ISSUE_STATES as readonly string[]).includes(value);
}

// Which repos a piece of work touches (decided during refinement).
export type RepoScope = 'service' | 'infra' | 'both';
export const REPO_SCOPES: readonly RepoScope[] = ['service', 'infra', 'both'];

export function isRepoScope(value: unknown): value is RepoScope {
  return typeof value === 'string' && (REPO_SCOPES as readonly string[]).includes(value);
}

export type RunRole = 'service' | 'infra';
export const RUN_ROLES: readonly RunRole[] = ['service', 'infra'];

export type RunState = 'pending' | 'developing' | 'pr' | 'failed' | 'merged' | 'released';
export const RUN_STATES: readonly RunState[] = [
  'pending',
  'developing',
  'pr',
  'failed',
  'merged',
  'released',
];

export type TopicStatus = 'idea' | 'active' | 'shipped' | 'dropped';
export const TOPIC_STATUSES: readonly TopicStatus[] = ['idea', 'active', 'shipped', 'dropped'];

export type ProjectStatus = 'healthy' | 'in-flight' | 'stale';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['healthy', 'in-flight', 'stale'];

export type ReleaseMode = 'tag' | 'manual';

export interface ModelOption {
  id: string;
  providerID: string;
}

export interface ProjectRow {
  id: number;
  name: string;
  service_repo_owner: string | null;
  service_repo_name: string | null;
  domain: string | null;
  deploy_host: string | null;
  deploy_dir: string | null;
  infra_dir: string | null;
  status: string | null;
  status_override: string | null;
  last_shipped_at: string | null;
  last_shipped_title: string | null;
  release_mode: string;
  config: string;
  created_at: string;
}

export interface Project {
  id: number;
  name: string;
  serviceRepoOwner: string | null;
  serviceRepoName: string | null;
  domain: string | null;
  deployHost: string | null;
  deployDir: string | null;
  infraDir: string | null;
  status: ProjectStatus | null;
  statusOverride: ProjectStatus | null;
  lastShippedAt: string | null;
  lastShippedTitle: string | null;
  releaseMode: ReleaseMode;
  config: unknown;
  createdAt: string;
}

export interface TopicRow {
  id: number;
  project_id: number | null;
  area: string | null;
  title: string;
  notes: string | null;
  status: TopicStatus;
  origin: 'manual' | 'suggested';
  created_at: string;
  updated_at: string;
}

export interface Topic {
  id: number;
  projectId: number | null;
  area: string | null;
  title: string;
  notes: string | null;
  status: TopicStatus;
  origin: 'manual' | 'suggested';
  createdAt: string;
  updatedAt: string;
}

export interface DevelopRunRow {
  id: number;
  issue_id: number;
  seq: number;
  role: RunRole;
  repo_owner: string;
  repo_name: string;
  state: RunState;
  session_id: string | null;
  pr_url: string | null;
  result_text: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DevelopRun {
  id: number;
  issueId: number;
  seq: number;
  role: RunRole;
  repoOwner: string;
  repoName: string;
  state: RunState;
  sessionId: string | null;
  prUrl: string | null;
  resultText: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRow {
  id: number;
  github_issue_id: number;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: IssueState;
  session_id: string | null;
  result_pr_url: string | null;
  result_text: string | null;
  blocked_reason: string | null;
  linked_pr_url: string | null;
  release_tag: string | null;
  released_at: string | null;
  state_reason: string | null;
  model_id: string | null;
  project_id: number | null;
  topic_id: number | null;
  repo_scope: RepoScope | null;
  infra_first: number;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  issue_id: number;
  kind: string;
  payload_json: string;
  ts: string;
}

export interface IssueEvent {
  id: number;
  issueId: number;
  kind: string;
  payload: unknown;
  ts: string;
}

export interface Issue {
  id: number;
  githubIssueId: number;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: IssueState;
  sessionId: string | null;
  resultPrUrl: string | null;
  resultText: string | null;
  blockedReason: string | null;
  linkedPrUrl: string | null;
  releaseTag: string | null;
  releasedAt: string | null;
  stateReason: string | null;
  modelId: string | null;
  // Optional in the type so pre-#167 fixtures stay valid; serializeIssue and
  // every ingest path always populate them.
  projectId?: number | null;
  topicId?: number | null;
  repoScope?: RepoScope | null;
  infraFirst?: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    githubIssueId: row.github_issue_id,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    htmlUrl: row.html_url,
    state: row.state,
    sessionId: row.session_id,
    resultPrUrl: row.result_pr_url,
    resultText: row.result_text,
    blockedReason: row.blocked_reason,
    linkedPrUrl: row.linked_pr_url,
    releaseTag: row.release_tag,
    releasedAt: row.released_at,
    stateReason: row.state_reason,
    modelId: row.model_id,
    projectId: row.project_id,
    topicId: row.topic_id,
    repoScope: row.repo_scope,
    infraFirst: row.infra_first === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeProject(row: ProjectRow): Project {
  const override = (row.status_override ?? null) as ProjectStatus | null;
  return {
    id: row.id,
    name: row.name,
    serviceRepoOwner: row.service_repo_owner,
    serviceRepoName: row.service_repo_name,
    domain: row.domain,
    deployHost: row.deploy_host,
    deployDir: row.deploy_dir,
    infraDir: row.infra_dir,
    status: (row.status ?? null) as ProjectStatus | null,
    statusOverride: override && (PROJECT_STATUSES as readonly string[]).includes(override) ? override : null,
    lastShippedAt: row.last_shipped_at,
    lastShippedTitle: row.last_shipped_title,
    releaseMode: row.release_mode === 'manual' ? 'manual' : 'tag',
    config: safeParseJson(row.config),
    createdAt: row.created_at,
  };
}

export function serializeTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    projectId: row.project_id,
    area: row.area,
    title: row.title,
    notes: row.notes,
    status: row.status,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeRun(row: DevelopRunRow): DevelopRun {
  return {
    id: row.id,
    issueId: row.issue_id,
    seq: row.seq,
    role: row.role,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    state: row.state,
    sessionId: row.session_id,
    prUrl: row.pr_url,
    resultText: row.result_text,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
