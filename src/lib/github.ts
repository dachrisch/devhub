import { ENV } from './env';
import { appendEvent, deleteIssueByGithub, getIssueByGithub, getIssues, reopenIssue, setClosed, setLinkedPrUrl, setRollout, upsertIssue } from './store';
import { publishIssue } from './sse';
import type { IssueState } from './types';

// Labels DevHub keeps in sync with its own issue state. Other labels on the
// issue are preserved.
export const STATE_LABELS: Record<IssueState, string> = {
  backlog: 'devhub:backlog',
  refinement: 'devhub:refinement',
  developing: 'devhub:developing',
  pr: 'devhub:pr',
  rollout: 'devhub:rollout',
  blocked: 'devhub:blocked',
  closed: 'devhub:closed',
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

async function ghGetJson<T>(url: string, token: string, fetchFn: FetchFn): Promise<T> {
  const res = await fetchFn(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub request failed (${res.status}): ${url}`);
  }
  return (await res.json()) as T;
}

function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

interface GhPull {
  merged?: boolean;
  merge_commit_sha?: string | null;
}

interface GhTag {
  name: string;
  commit: { sha: string };
}

// True when the tag's commit is the merge commit itself or a descendant of it
// (GitHub compare: `ahead`/`identical` mean base is an ancestor of head).
async function tagContainsCommit(
  owner: string,
  repo: string,
  mergeSha: string,
  tag: GhTag,
  token: string,
  fetchFn: FetchFn
): Promise<boolean> {
  const cmp = await ghGetJson<{ status?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/compare/${mergeSha}...${tag.commit.sha}`,
    token,
    fetchFn
  );
  return cmp.status === 'identical' || cmp.status === 'ahead';
}

// Returns the first release tag whose commit contains the PR's merge commit,
// or null when the PR is merged but not yet released.
async function findReleaseTag(
  owner: string,
  repo: string,
  mergeSha: string,
  token: string,
  fetchFn: FetchFn
): Promise<string | null> {
  const tags = await ghGetJson<GhTag[]>(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=20`, token, fetchFn);
  for (const tag of tags) {
    try {
      if (await tagContainsCommit(owner, repo, mergeSha, tag, token, fetchFn)) return tag.name;
    } catch {
      // skip tags the compare endpoint can't resolve
    }
  }
  return null;
}

// Polls GitHub for the "PR merged + release tag cut" signal and advances
// `pr` cards (and `closed` cards still carrying a PR — e.g. reconciled before
// the tag was cut) to the terminal `rollout` state automatically. Returns the
// number of cards moved. Runs as part of refresh; failures leave cards put.
export async function sweepRollouts(token: string, fetchFn: FetchFn = fetch): Promise<number> {
  const candidates = getIssues().filter((i) => i.state === 'pr' || i.state === 'closed');
  let rolledOut = 0;
  for (const issue of candidates) {
    const prNumber = prNumberFromUrl(issue.resultPrUrl) ?? prNumberFromUrl(issue.linkedPrUrl);
    if (!prNumber) continue;
    try {
      const pr = await ghGetJson<GhPull>(
        `https://api.github.com/repos/${issue.owner}/${issue.repo}/pulls/${prNumber}`,
        token,
        fetchFn
      );
      if (!pr.merged || !pr.merge_commit_sha) continue;
      const releaseTag = await findReleaseTag(issue.owner, issue.repo, pr.merge_commit_sha, token, fetchFn);
      if (!releaseTag) continue;
      const updated = setRollout(issue.id, releaseTag);
      if (!updated) continue;
      publishIssue(updated);
      rolledOut++;
      try {
        await setIssueStateLabels(issue.owner, issue.repo, issue.number, 'rollout', token, fetchFn);
      } catch {
        // label mirroring is best-effort
      }
    } catch {
      // transient API failure: leave the card for the next sweep
    }
  }
  return rolledOut;
}

// States re-checked against GitHub on every refresh. `developing` is left to
// the live run and `rollout` is DevHub's own terminal pipeline state; every
// other card gets reconciled so GitHub-closed issues stop accumulating.
// `closed` is included so a card GitHub reopened can move back onto the board.
const RECONCILE_STATES = ['backlog', 'refinement', 'pr', 'blocked', 'closed'] as const;

// Catch-up reconciliation: the ingest loop only fetches `state=open` issues,
// so an issue closed outside DevHub's pipeline (manually, duplicate/wontfix,
// fixed by hand, or even auto-closed by a merge before the rollout sweep saw
// the tag) would otherwise sit on the board forever. For every locally-tracked
// non-terminal card, checks the current GitHub state and:
//   - closed on GitHub → move to the `closed` terminal state (recording why),
//   - open on GitHub but reconciled `closed` → reopen into `backlog`.
// Runs after sweepRollouts so merged+tagged PRs become `rollout` first.
// Returns the number of cards reconciled.
export async function reconcileClosedIssues(token: string, fetchFn: FetchFn = fetch): Promise<number> {
  const candidates = getIssues().filter((i) => (RECONCILE_STATES as readonly string[]).includes(i.state));
  let reconciled = 0;
  for (const issue of candidates) {
    try {
      const detail = await ghGetJson<{ state?: string; state_reason?: string | null }>(
        `https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`,
        token,
        fetchFn
      );
      // Only trust explicit open/closed answers; anything else (malformed,
      // transient, or an endpoint that didn't return the issue) is left alone.
      if (detail.state !== 'open' && detail.state !== 'closed') continue;
      if (detail.state === 'open') {
        if (issue.state === 'closed') {
          const reopened = reopenIssue(issue.id);
          if (!reopened) continue;
          publishIssue(reopened);
          appendEvent(issue.id, 'reopened', {});
          reconciled++;
          try {
            await setIssueStateLabels(issue.owner, issue.repo, issue.number, 'backlog', token, fetchFn);
          } catch {
            // label mirroring is best-effort
          }
        }
        continue;
      }
      if (issue.state === 'closed') continue; // already reconciled
      const updated = setClosed(issue.id, detail.state_reason ?? null);
      if (!updated) continue;
      publishIssue(updated);
      appendEvent(issue.id, 'closed', { reason: detail.state_reason ?? null });
      reconciled++;
      try {
        await setIssueStateLabels(issue.owner, issue.repo, issue.number, 'closed', token, fetchFn);
      } catch {
        // label mirroring is best-effort
      }
    } catch {
      // transient API failure: leave the card for the next pass
    }
  }
  return reconciled;
}

interface GhSearchIssue {
  html_url: string;
  pull_request?: unknown;
}

async function findLinkedPr(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  fetchFn: FetchFn
): Promise<string | null> {
  const query = `repo:${owner}/${repo} ${issueNumber} is:pr is:open`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=5`;
  const res = await fetchFn(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const data = (await res.json()) as { items?: GhSearchIssue[] };
  const items = data.items ?? [];
  const pr = items.find((i) => Boolean(i.pull_request));
  if (pr) return pr.html_url;

  const mergedQuery = `repo:${owner}/${repo} ${issueNumber} is:pr is:merged`;
  const mergedUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(mergedQuery)}&sort=updated&per_page=5`;
  const mergedRes = await fetchFn(mergedUrl, { headers: ghHeaders(token) });
  if (!mergedRes.ok) return null;
  const mergedData = (await mergedRes.json()) as { items?: GhSearchIssue[] };
  const mergedItems = mergedData.items ?? [];
  const mergedPr = mergedItems.find((i) => Boolean(i.pull_request));
  return mergedPr ? mergedPr.html_url : null;
}

const SEARCH_DELAY_MS = 1000;

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

const MEMBER_CHECK_ATTEMPTS = 3;
const MEMBER_CHECK_RETRY_DELAY_MS = 500;

// True when the authenticated user is a member of GITHUB_ALLOWED_ORG.
// Used by the callback (authorization gate) and refresh (revocation re-check).
// The org list is on the hot path for every mutating request, so transient
// GitHub failures (rate limiting / 5xx / network blips) are retried with
// backoff before giving up — a single blip must not knock the board read-only.
export async function isAllowedMember(token: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MEMBER_CHECK_ATTEMPTS; attempt++) {
    try {
      const orgs = (await ghGet('https://api.github.com/user/orgs', token, fetchFn)) as Array<{ login: string }>;
      const allowed = ENV.githubAllowedOrg.toLowerCase();
      const result = orgs.some((o) => o.login.toLowerCase() === allowed);
      if (!result) {
        console.error('[isAllowedMember] orgs:', orgs.map((o) => o.login), '| allowed:', allowed);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < MEMBER_CHECK_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, MEMBER_CHECK_RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

// Ingests open issues from all repos the authenticated user can access that
// match GITHUB_TOPICS, advances merged+tagged PRs to `rollout`, and reconciles
// cards whose issue has since been closed on GitHub. The token comes from the
// session — never from env.
export async function refreshIssues(token: string, fetchFn: FetchFn = fetch): Promise<{ repos: number; issues: number; rolledOut: number; closed: number }> {
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
      const stored = getIssueByGithub(repo.owner.login, repo.name, issue.number);
      if (stored) {
        const linkedPrUrl = await findLinkedPr(repo.owner.login, repo.name, issue.number, token, fetchFn);
        setLinkedPrUrl(stored.id, linkedPrUrl);
        if (linkedPrUrl) await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS));
      }
      issueCount++;
    }
  }

  const rolledOut = await sweepRollouts(token, fetchFn);
  const closed = await reconcileClosedIssues(token, fetchFn);
  return { repos: matchingRepos.length, issues: issueCount, rolledOut, closed };
}
