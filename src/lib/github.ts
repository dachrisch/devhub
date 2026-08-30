import { ENV } from './env';
import { deleteIssueByGithub, upsertIssue } from './store';
import type { IssueState } from './types';

// Labels DevHub keeps in sync with its own issue state. Other labels on the
// issue are preserved.
export const STATE_LABELS: Record<IssueState, string> = {
  backlog: 'devhub:backlog',
  developing: 'devhub:developing',
  pr: 'devhub:pr',
  blocked: 'devhub:blocked',
};

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
  token: string,
  fetchFn: FetchFn = fetch
): Promise<void> {
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
  token: string,
  fetchFn: FetchFn = fetch
): Promise<void> {
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
    headers: ghHeaders(token),
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

// True when the authenticated user is a member of GITHUB_ALLOWED_ORG.
// Used by the callback (authorization gate) and refresh (revocation re-check).
export async function isAllowedMember(token: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  const orgs = (await ghGet('https://api.github.com/user/orgs', token, fetchFn)) as Array<{ login: string }>;
  const allowed = ENV.githubAllowedOrg.toLowerCase();
  const result = orgs.some((o) => o.login.toLowerCase() === allowed);
  if (!result) {
    console.error('[isAllowedMember] orgs:', orgs.map((o) => o.login), '| allowed:', allowed);
  }
  return result;
}

// Ingests open issues from all repos the authenticated user can access that
// match GITHUB_TOPICS. The token comes from the session — never from env.
export async function refreshIssues(token: string, fetchFn: FetchFn = fetch): Promise<{ repos: number; issues: number }> {
  const repos = (await ghGet('https://api.github.com/user/repos', token, fetchFn)) as GhRepo[];
  const matchingRepos = repos.filter((repo) => repoMatchesTopics(repo.topics, ENV.githubTopics));

  let issueCount = 0;
  for (const repo of matchingRepos) {
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
