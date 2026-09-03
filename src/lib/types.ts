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

export interface ModelOption {
  id: string;
  providerID: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
