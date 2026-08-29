import { ENV } from './env';
import { upsertIssue } from './store';

const OWNER = 'dachrisch';
const ORG = 'bumbleflies';

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
}

// A repo qualifies when any of its GitHub topics intersect the wanted set.
export function repoMatchesTopics(topics: string[] | undefined, wanted: string[]): boolean {
  if (!topics || topics.length === 0) return false;
  return topics.some((t) => wanted.includes(t));
}

export function isPullRequest(issue: GhIssue): boolean {
  return Boolean(issue.pull_request);
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
    const repos = (await ghGet(`https://api.github.com/orgs/${owner}/repos`, token, fetchFn)) as GhRepo[];
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
