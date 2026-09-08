import type { DevelopRun } from './types';

// Auto-merge worker (devhub#171 Phase 4): after `pr`, poll PR checks, then
// merge via the REST API with the session token (the codebase has no `gh` CLI
// dependency and tokens are always passed as arguments, never via env):
//   - checks green → `PUT /repos/{owner}/{repo}/pulls/{n}/merge` (squash);
//   - branch protection pending → GraphQL `enablePullRequestAutoMerge` (the
//     `--auto` equivalent) and let the sweep observe the merge.
// On merge, ensure a tag via the same REST token so the existing
// `sweepRunsForIssue` flips `merged → released` (tag mode). Manual-mode
// projects take the Mark-shipped path auto-clicked when `auto_merge = 1`.
// Per-run and idempotent: already-merged PRs skip straight to the release
// step, and every outcome is explicit so the realize waiter can react
// (pending → retry next tick, failed → blocked_reason).
//
// NOTE on tag names: the spec sketch says "a `v…` tag", but release-please
// manages real versions in this repo — an automated `vX.Y.Z` would collide
// with the release pipeline. The sweep accepts ANY tag containing the merge
// commit, so the worker cuts a clearly-automated `devhub-auto-…` tag.

export type FetchFn = typeof fetch;

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export interface AutoMergeOutcome {
  outcome: 'merged' | 'already-merged' | 'pending' | 'failed' | 'skipped';
  /** Present when the merge itself is done (this tick or earlier). */
  mergeSha?: string;
  /** Present when a release tag was cut (tag mode) or the run was auto-released (manual mode). */
  released?: boolean;
  reason: string;
}

interface GhPullDetail {
  merged?: boolean;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: { sha?: string };
  node_id?: string;
}

interface GhCombinedStatus {
  state?: string;
}

function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function autoTagName(runId: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  return `devhub-auto-r${runId}-${stamp}`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// One attempt for a single run. Never throws — every GitHub answer maps to an
// explicit outcome.
export async function autoMergeAndRelease(
  run: DevelopRun,
  project: { autoMerge: boolean; releaseMode: 'tag' | 'manual' } | null,
  token: string,
  fetchFn: FetchFn = fetch
): Promise<AutoMergeOutcome> {
  if (!project?.autoMerge) {
    return { outcome: 'skipped', reason: 'auto-merge is off for this project' };
  }
  const prNumber = prNumberFromUrl(run.prUrl);
  if (!prNumber) {
    return { outcome: 'skipped', reason: 'run has no PR url yet' };
  }
  const { repoOwner: owner, repoName: repo } = run;

  let pr: GhPullDetail;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) return { outcome: 'pending', reason: `PR lookup failed (HTTP ${res.status})` };
    pr = (await readJson(res)) as GhPullDetail;
  } catch (err) {
    return { outcome: 'pending', reason: `PR lookup failed (${err instanceof Error ? err.message : String(err)})` };
  }

  // Already merged (by us on an earlier tick, or by hand): release step only.
  if (pr.merged && pr.merge_commit_sha) {
    return releaseStep(owner, repo, pr.merge_commit_sha, run, project, token, fetchFn, true);
  }

  const headSha = pr.head?.sha;
  if (!headSha) {
    return { outcome: 'pending', reason: 'PR has no head sha yet' };
  }

  // Combined commit status is the CI signal (success / failure / pending).
  let combined: string | undefined;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`, {
      headers: ghHeaders(token),
    });
    if (res.ok) combined = ((await readJson(res)) as GhCombinedStatus)?.state;
  } catch {
    // unknown → fall through to mergeable_state below
  }

  if (combined === 'failure' || combined === 'error') {
    return { outcome: 'failed', reason: `CI checks failing on PR #${prNumber} — fix and push, then Realize resumes` };
  }

  // Dirty = merge conflict: no automation can fix it.
  if (pr.mergeable_state === 'dirty' || pr.mergeable === false) {
    return { outcome: 'failed', reason: `PR #${prNumber} has a merge conflict — resolve it on GitHub, then Realize resumes` };
  }

  const green = combined === 'success' || pr.mergeable_state === 'clean';
  if (!green) {
    // Pending checks, draft, or unknown state: wait for the next tick.
    // (Spec §6.4: branch protection pending → GraphQL auto-merge below only
    // fires once CI itself is green; before that we just wait.)
    if (combined === 'success') {
      const auto = await enableAutoMerge(pr, token, fetchFn);
      if (auto.ok) return { outcome: 'pending', reason: `auto-merge armed on PR #${prNumber}, waiting for the merge` };
      return { outcome: 'pending', reason: `PR #${prNumber} is green but protected (${auto.reason}); waiting` };
    }
    return { outcome: 'pending', reason: `waiting for CI on PR #${prNumber}` };
  }

  // Green → squash-merge now.
  try {
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: 'squash' }),
    });
    const body = (await readJson(res)) as { merged?: boolean; sha?: string; message?: string };
    if (res.ok && (body.merged || body.sha)) {
      const sha = body.sha ?? pr.merge_commit_sha ?? headSha;
      return releaseStep(owner, repo, sha, run, project, token, fetchFn, false);
    }
    // 405 with protection wording → arm auto-merge instead of failing.
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
    if (res.status === 405) {
      const auto = await enableAutoMerge(pr, token, fetchFn);
      if (auto.ok) return { outcome: 'pending', reason: `auto-merge armed on PR #${prNumber}, waiting for the merge` };
      return { outcome: 'pending', reason: `merge blocked on PR #${prNumber} (${message}); waiting` };
    }
    return { outcome: 'pending', reason: `merge attempt on PR #${prNumber} failed (${message}); retrying` };
  } catch (err) {
    return { outcome: 'pending', reason: `merge attempt failed (${err instanceof Error ? err.message : String(err)}); retrying` };
  }
}

async function enableAutoMerge(
  pr: GhPullDetail,
  token: string,
  fetchFn: FetchFn
): Promise<{ ok: boolean; reason: string }> {
  if (!pr.node_id) return { ok: false, reason: 'no PR node id for GraphQL' };
  try {
    const res = await fetchFn('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'mutation($id:ID!,$method:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){pullRequest{autoMergeRequest{enabledAt}}}}',
        variables: { id: pr.node_id, method: 'SQUASH' },
      }),
    });
    const body = (await readJson(res)) as { errors?: { message?: string }[] };
    if (res.ok && !body.errors?.length) return { ok: true, reason: 'armed' };
    const reason = body.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function releaseStep(
  owner: string,
  repo: string,
  mergeSha: string,
  run: DevelopRun,
  project: { autoMerge: boolean; releaseMode: 'tag' | 'manual' },
  token: string,
  fetchFn: FetchFn,
  alreadyMerged: boolean
): Promise<AutoMergeOutcome> {
  if (project.releaseMode === 'manual') {
    // Mark-shipped path, auto-clicked: `released: true` tells the caller
    // (realize waiter) to flip this run to released — the sweep then rolls
    // the issue out once every run released. Per-run, so a half-merged
    // `both`-scope issue is never marked shipped early.
    return {
      outcome: alreadyMerged ? 'already-merged' : 'merged',
      mergeSha,
      released: true,
      reason: 'manual release mode: run auto-released after merge',
    };
  }
  // Tag mode: cut an annotated tag + ref containing the merge commit so the
  // existing sweep flips merged → released on its next pass.
  const tag = autoTagName(run.id);
  try {
    const tagRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/git/tags`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, message: `DevHub auto-release for run #${run.id}`, object: mergeSha, type: 'commit' }),
    });
    if (!tagRes.ok) {
      return {
        outcome: alreadyMerged ? 'already-merged' : 'merged',
        mergeSha,
        reason: `merged but tag cut failed (HTTP ${tagRes.status}); sweep will retry the release`,
      };
    }
    const refRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: mergeSha }),
    });
    if (!refRes.ok) {
      return {
        outcome: alreadyMerged ? 'already-merged' : 'merged',
        mergeSha,
        reason: `merged but tag ref failed (HTTP ${refRes.status}); sweep will retry the release`,
      };
    }
    return {
      outcome: alreadyMerged ? 'already-merged' : 'merged',
      mergeSha,
      released: true,
      reason: `merged + tag ${tag} cut; sweep releases next pass`,
    };
  } catch (err) {
    return {
      outcome: alreadyMerged ? 'already-merged' : 'merged',
      mergeSha,
      reason: `merged but tag cut failed (${err instanceof Error ? err.message : String(err)}); sweep will retry`,
    };
  }
}
