import { ENV } from './env';
import { deleteIssueByGithub, upsertIssue } from './store';
import type { IssueState } from './types';

const OWNER = 'dachrisch';
const ORG = 'bumbleflies';

// Labels DevHub keeps in sync with its own issue state. Other labels on the
// issue are preserved.
export const STATE_LABELS: Record<IssueState, string> = {
  backlog: 'devhub:backlog',
  developing: 'devhub:developing',
  pr: 'devhub:pr',
  blocked: 'devhub:blocked',
};

function tokenForOwner(owner: string): string {
  return owner === OWNER ? ENV.ghToken : ENV.bumblefliesGhToken;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Mirrors the DevHub state onto the GitHub issue as a `devhub:*` label,
// leaving any other labels untouched. Best-effort: network/auth failures are
// swallowed by the caller.
export async function setIssueStateLabels(
  owner: string,
  repo: string,
  number: number,
  state: IssueState,
  fetchFn: FetchFn = fetch
): Promise<void> {
  const token = tokenForOwner(owner);
  if (!token) return;
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  const res = await fetchFn(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub issue fetch failed (${res.status})`);
  const issue = (await res.json()) as { labels?: Array<string | { name: string }> };
  const current = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  const stateLabels = Object.values(STATE_LABELS);
  const next = [...current.filter((l) => !stateLabels.includes(l)), STATE_LABELS[state]];
  const patch = await fetchFn(url, {
    method: 'PATCH',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: next }),
  });
  if (!patch.ok) throw new Error(`GitHub label update failed (${patch.status})`);
}

export async function commentOnIssue(
  owner: string,
  repo: string,
  number: number,
  body: string,
  fetchFn: FetchFn = fetch
): Promise<void> {
  const token = tokenForOwner(owner);
  if (!token) return;
  const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: body.slice(0, 60000) }),
  });
  if (!res.ok) throw new Error(`GitHub comment failed (${res.status})`);
}

export interface GhRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  topics?: string[];
}

export interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
  user?: { login: string; type?: string };
}

// A repo qualifies when any of its GitHub topics intersect the wanted set.
export function repoMatchesTopics(topics: string[] | undefined, wanted: string[]): boolean {
  if (!topics || topics.length === 0) return false;
  return topics.some((t) => wanted.includes(t));
}

export function isPullRequest(issue: GhIssue): boolean {
  return Boolean(issue.pull_request);
}

// Issues opened by automation (Renovate, Dependabot, GitHub Actions, ...) are
// static dependency-update config, not actionable work items.
export function isBotIssue(issue: GhIssue): boolean {
  if (issue.user?.type === 'Bot') return true;
  return /bot$/i.test(issue.user?.login ?? '');
}

type FetchFn = typeof fetch;

async function ghGet(url: string, token: string, fetchFn: FetchFn, acc: unknown[] = []): Promise<unknown[]> {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetchFn(`${url}${sep}per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) {
    throw new Error(`GitHub request failed (${res.status}): ${url}`);
  }
  const data = (await res.json()) as unknown[];
  const next = nextPage(res);
  if (next && data.length === 100) {
    return ghGet(next, token, fetchFn, acc.concat(data));
  }
  return acc.concat(data);
}

function nextPage(res: Response): string | null {
  const link = res.headers.get('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export async function refreshIssues(fetchFn: FetchFn = fetch): Promise<{ repos: number; issues: number }> {
  const targets: Array<{ owner: string; token: string }> = [
    { owner: OWNER, token: ENV.ghToken },
    { owner: ORG, token: ENV.bumblefliesGhToken },
  ];

  const matchingRepos: GhRepo[] = [];
  for (const { owner, token } of targets) {
    if (!token) continue;
    const repos = (await ghGet(`https://api.github.com/users/${owner}/repos`, token, fetchFn)) as GhRepo[];
    for (const repo of repos) {
      if (repoMatchesTopics(repo.topics, ENV.githubTopics)) {
        matchingRepos.push(repo);
      }
    }
  }

  let issueCount = 0;
  for (const repo of matchingRepos) {
    const token = repo.owner.login === OWNER ? ENV.ghToken : ENV.bumblefliesGhToken;
    if (!token) continue;
    const issues = (await ghGet(`https://api.github.com/repos/${repo.full_name}/issues`, token, fetchFn)) as GhIssue[];
    for (const issue of issues) {
      if (isPullRequest(issue)) continue;
      if (isBotIssue(issue)) {
        deleteIssueByGithub(repo.owner.login, repo.name, issue.number);
        continue;
      }
      upsertIssue({
        githubIssueId: issue.id,
        owner: repo.owner.login,
        repo: repo.name,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        htmlUrl: issue.html_url,
      });
      issueCount++;
    }
  }

  return { repos: matchingRepos.length, issues: issueCount };
}
