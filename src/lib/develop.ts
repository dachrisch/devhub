import {
  appendEvent,
  clearBlockedReason,
  ensureRuns,
  getIssue,
  getProject,
  getRunsForIssue,
  setBlockedReason,
  setDefaultModel,
  setIssueBody,
  setIssueScope,
  setIssueState,
  setResult,
  setSessionId,
  updateRun,
  type DevelopRun,
  type Issue,
} from './store';
import {
  buildDevelopPrompt,
  extractPrUrl,
  getAvailableModels,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type DevelopCarryOver,
  type OpencodeEvent,
  type OpencodeModel,
} from './opencode';
import { isIssueClosedOnGitHub, setIssueStateLabels, updateIssueBody } from './github';
import { publishIssue, publishOpencodeEvent, publishRun } from './sse';
import { mirrorComment } from './utils';
import { buildRefinePrompt, parseRefineResult } from './validate';
import { ENV } from './env';
import type { RunRole } from './types';

// Issues with a refinement run currently in flight. `refinement` is a state,
// not a run marker, so without this a second "Work" click would start a
// concurrent duplicate run (two assessments racing the same issue, both able
// to proceed to develop). Process-local: single prod server, fire-and-forget.
const liveRefinementRuns = new Set<number>();

// Best-effort mirror of DevHub state/notes onto the GitHub issue (labels +
// a comment). Failures here must never break the develop run.
async function mirrorLabels(issue: Issue, state: Issue['state'], token: string): Promise<void> {
  try {
    await setIssueStateLabels(issue.owner, issue.repo, issue.number, state, token);
  } catch {
    /* non-fatal */
  }
}

// Translates the refinement-decided scope into an ordered run plan. Falls back
// to service-only when the scope is unset or the shared infra repo is not
// configured (single-PR legacy behavior).
export function planRunsForIssue(issue: Issue): { role: RunRole; repoOwner: string; repoName: string }[] {
  const scope = issue.repoScope ?? 'service';
  const infra = ENV.infraRepo;
  if ((scope === 'infra' || scope === 'both') && !infra) {
    return [{ role: 'service', repoOwner: issue.owner, repoName: issue.repo }];
  }
  if (scope === 'infra' && infra) {
    return [{ role: 'infra', repoOwner: infra.owner, repoName: infra.name }];
  }
  if (scope === 'both' && infra) {
    const service = { role: 'service' as const, repoOwner: issue.owner, repoName: issue.repo };
    const infraRun = { role: 'infra' as const, repoOwner: infra.owner, repoName: infra.name };
    return issue.infraFirst ? [infraRun, service] : [service, infraRun];
  }
  return [{ role: 'service', repoOwner: issue.owner, repoName: issue.repo }];
}

// Kicks off (and runs to completion) the develop sessions for an issue.
// Phase 3 (devhub#167): scope translates into sequential per-repo child runs
// (one session → one repo → one PR); each run keeps the legacy
// "final message ends in a PR URL" contract. Intended to be called
// fire-and-forget from the API route: it owns all server-side state
// transitions and broadcasts them over SSE. `token` is the operator's GitHub
// OAuth token used for state mirroring on the issue.
// `selectedModel` (optional) heads the model list for this run; when provided it
// is also remembered as the operator's global default for the next run.
export async function startDevelop(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  const developing = setIssueState(issue.id, 'developing');
  if (developing) publishIssue(developing);
  void mirrorLabels(issue, 'developing', token);
  void mirrorComment(issue, 'DevHub started developing this issue.', token);

  const models = sanitizeModels(resolveModels(selectedModel), await getAvailableModels());
  if (selectedModel?.id) {
    setDefaultModel({ id: selectedModel.id, providerID: selectedModel.providerID });
  }
  const head = models[0];
  appendEvent(issue.id, 'model', { id: head.id, providerID: head.providerID });

  // Create/refresh the run plan idempotently: retry must not duplicate or
  // reset runs that already produced a PR.
  const plan = planRunsForIssue(getIssue(issue.id) ?? issue);
  let runs = ensureRuns(issue.id, plan);
  // Preserve the planned order (seq) rather than role sort.
  runs = runs.slice().sort((a, b) => a.seq - b.seq);

  const projectId = (getIssue(issue.id) ?? issue).projectId ?? null;
  let carryOver: DevelopCarryOver | null = null;
  // Rebuild carry-over from runs that already produced PRs (retry path).
  for (const r of runs) {
    if (r.prUrl && (r.state === 'pr' || r.state === 'merged' || r.state === 'released')) {
      carryOver = { prUrl: r.prUrl, summary: (r.resultText ?? '').slice(0, 2000) };
    }
  }

  try {
    for (const run of runs) {
      const fresh = getRunsForIssue(issue.id).find((r) => r.id === run.id) ?? run;
      // Skip runs that already produced a PR — retry touches only failed/missing.
      if (fresh.state === 'pr' || fresh.state === 'merged' || fresh.state === 'released') {
        if (fresh.prUrl) carryOver = { prUrl: fresh.prUrl, summary: (fresh.resultText ?? '').slice(0, 2000) };
        continue;
      }
      await runSingleChildRun(issue, fresh, command, token, models, projectId, carryOver, (next) => {
        carryOver = next;
      });
      const after = getRunsForIssue(issue.id).find((r) => r.id === run.id);
      // A failed run stops the chain; the card stays `developing` with a
      // repo-named blocked_reason and the next Work click retries only it.
      if (after?.state === 'failed' || after?.blockedReason) return;
      if (after?.prUrl) carryOver = { prUrl: after.prUrl, summary: (after.resultText ?? '').slice(0, 2000) };
    }

    const finalRuns = getRunsForIssue(issue.id);
    const prUrls = finalRuns.map((r) => r.prUrl).filter((u): u is string => Boolean(u));
    if (prUrls.length > 0 && prUrls.length === finalRuns.length) {
      const summary = finalRuns.map((r) => `${r.role}: ${r.prUrl}`).join('\n');
      const updated = setResult(issue.id, 'pr', prUrls[0] ?? null, summary);
      if (updated) publishIssue(updated);
      void mirrorLabels(issue, 'pr', token);
      void mirrorComment(issue, `DevHub opened ${prUrls.length} pull request(s):\n${summary}`, token);
    } else if (finalRuns.length > 0 && finalRuns.every((r) => r.state === 'released')) {
      const updated = setResult(issue.id, 'closed', null, 'All runs already resolved.');
      if (updated) publishIssue(updated);
      void mirrorLabels(issue, 'closed', token);
    } else if (prUrls.length === 0) {
      // No run produced a PR and none failed explicitly (e.g. ALREADY
      // RESOLVED without runs): fall back to the legacy single-PR decision.
      const lastText = finalRuns.map((r) => r.resultText ?? '').join('\n');
      const alreadyResolved =
        lastText.includes('ALREADY RESOLVED') ||
        (await isIssueClosedOnGitHub(issue.owner, issue.repo, issue.number, token)) ||
        Boolean(issue.linkedPrUrl);
      if (alreadyResolved) {
        const updated = setResult(issue.id, 'closed', null, lastText.slice(0, 4000) || 'Already resolved.');
        if (updated) publishIssue(updated);
        void mirrorLabels(issue, 'closed', token);
      }
      // Otherwise the failed run already set the blocked_reason and returned.
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'error', { message: reason });
    const updated = setBlockedReason(issue.id, `CANNOT FULFILL: ${reason}`);
    if (updated) publishIssue(updated);
    void mirrorComment(issue, `DevHub could not fulfill this issue: ${reason}`, token);
  }
}

async function runSingleChildRun(
  issue: Issue,
  run: DevelopRun,
  command: string,
  token: string,
  models: OpencodeModel[],
  projectId: number | null,
  carryOver: DevelopCarryOver | null,
  onCarryOver: (next: DevelopCarryOver) => void
): Promise<void> {
  updateRun(run.id, { state: 'developing', blockedReason: null });
  publishRun(run.id, issue.id);
  const onEvent = (event: OpencodeEvent) => {
    appendEvent(issue.id, 'opencode', { ...event, runId: run.id, role: run.role });
    publishOpencodeEvent(issue.id, event);
  };
  try {
    const prompt = buildDevelopPrompt(
      issue,
      command,
      { role: run.role, repoOwner: run.repoOwner, repoName: run.repoName, projectId },
      carryOver
    );
    const text = await runDevelop(prompt, onEvent, models, (sessionId) => {
      updateRun(run.id, { sessionId });
      publishRun(run.id, issue.id);
      setSessionId(issue.id, sessionId);
      const withSession = getIssue(issue.id);
      if (withSession) publishIssue(withSession);
    });

    const prUrl = extractPrUrl(text);
    if (prUrl) {
      updateRun(run.id, { state: 'pr', prUrl, resultText: text.slice(0, 8000), blockedReason: null });
      publishRun(run.id, issue.id);
      onCarryOver({ prUrl, summary: text.slice(0, 2000) });
      return;
    }
    const alreadyResolved =
      text.includes('ALREADY RESOLVED') ||
      (await isIssueClosedOnGitHub(run.repoOwner, run.repoName, issue.number, token).catch(() => false)) ||
      Boolean(issue.linkedPrUrl);
    if (alreadyResolved) {
      updateRun(run.id, { state: 'released', resultText: text.slice(0, 8000), blockedReason: null });
      publishRun(run.id, issue.id);
      return;
    }
    // Stage failure: run `failed` + issue blocked_reason naming the repo; chain stops.
    updateRun(run.id, { state: 'failed', resultText: text.slice(0, 8000), blockedReason: text.slice(0, 500) });
    publishRun(run.id, issue.id);
    const updated = setBlockedReason(issue.id, `${run.role}: ${text.slice(0, 500)}`);
    if (updated) publishIssue(updated);
    void mirrorComment(issue, `DevHub finished ${run.role} (${run.repoOwner}/${run.repoName}) but did not open a PR.\n\n${text.slice(0, 4000)}`, token);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'error', { message: reason, runId: run.id, role: run.role });
    updateRun(run.id, { state: 'failed', blockedReason: `CANNOT FULFILL: ${reason}`.slice(0, 500) });
    publishRun(run.id, issue.id);
    const updated = setBlockedReason(issue.id, `${run.role}: CANNOT FULFILL: ${reason}`.slice(0, 500));
    if (updated) publishIssue(updated);
    void mirrorComment(issue, `DevHub could not fulfill ${run.role} (${run.repoOwner}/${run.repoName}): ${reason}`, token);
  }
}

// Refinement stage: assess the issue with opencode, auto-refine the body when
// possible, and proceed to develop when ready. On failure the issue stays in
// `refinement` with a `blocked_reason` — the next "Work" click re-runs this.
// Only one refinement run per issue at a time; a second "Work" click while a
// run is live is a no-op.
async function runRefinement(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  if (liveRefinementRuns.has(issue.id)) return;
  liveRefinementRuns.add(issue.id);
  try {
    await runRefinementInner(issue, command, token, selectedModel);
  } finally {
    liveRefinementRuns.delete(issue.id);
  }
}

async function runRefinementInner(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  clearBlockedReason(issue.id);
  appendEvent(issue.id, 'refinement', { status: 'started' });

  try {
    const models = sanitizeModels(resolveModels(selectedModel), await getAvailableModels());
    const project = issue.projectId != null ? getProject(issue.projectId) : null;
    const prompt = buildRefinePrompt(issue, project ? { name: project.name, config: project.config } : null);
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'refinement-event', event);
      publishOpencodeEvent(issue.id, event);
    };

    const text = await runDevelop(prompt, onEvent, models, undefined, ENV.opencodeRefinementPollTimeoutMs);
    const result = parseRefineResult(text);
    // Persist the refinement-decided repo scope even when not ready — the
    // next Work click reuses it for the run plan.
    setIssueScope(issue.id, result.scope, result.infraFirst);

    appendEvent(issue.id, 'refinement', {
      status: 'completed',
      ready: result.ready,
      summary: result.summary,
      blockingQuestions: result.blockingQuestions,
      scope: result.scope,
      infraFirst: result.infraFirst,
    });

    if (!result.ready) {
      const feedback =
        result.blockingQuestions.length > 0
          ? result.blockingQuestions.map((q) => `- ${q}`).join('\n')
          : result.summary;
      const updated = setBlockedReason(issue.id, feedback);
      if (updated) publishIssue(updated);
      void mirrorComment(issue, `DevHub needs input to proceed:\n\n${feedback}`, token);
      return;
    }

    if (result.improvedBody) {
      void updateIssueBody(issue.owner, issue.repo, issue.number, result.improvedBody, token);
      setIssueBody(issue.id, result.improvedBody);
      void mirrorComment(issue, 'DevHub refined this issue (added acceptance criteria, clarified scope).', token);
    } else {
      void mirrorComment(issue, `DevHub validation: ready — ${result.summary}`, token);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'refinement-error', { message: reason });
    const updated = setBlockedReason(issue.id, `Refinement failed: ${reason}`);
    if (updated) publishIssue(updated);
    void mirrorComment(issue, `DevHub refinement failed: ${reason}`, token);
    return;
  }

  // Proceed to develop with the freshly-loaded issue — the body may have been
  // refined above, and the develop prompt must implement the improved text.
  const fresh = getIssue(issue.id) ?? issue;
  await startDevelop(fresh, command, token, selectedModel);
}

// Unified entry point behind the single "Work" button (devhub#132). Routes by
// the issue's current stage so a card always resumes from where it is:
//   backlog     → refinement (readiness check) → develop when ready
//   refinement  → re-check (user may have updated the issue)
//   developing  → retry after a failed run (blocked_reason set)
//   pr/rollout/closed → no-op
export async function startWork(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  if (issue.state === 'backlog') {
    const moved = setIssueState(issue.id, 'refinement');
    if (moved) publishIssue(moved);
    void mirrorLabels(issue, 'refinement', token);
    return await runRefinement(moved ?? issue, command, token, selectedModel);
  }

  if (issue.state === 'refinement') {
    return await runRefinement(issue, command, token, selectedModel);
  }

  if (issue.state === 'developing') {
    // Only reachable when a previous run failed (see canDevelop): a live run
    // must never get a concurrent duplicate session in the same worktree.
    clearBlockedReason(issue.id);
    return await startDevelop(issue, command, token, selectedModel);
  }

  // pr / rollout / closed — nothing to do.
}

export function canDevelop(issue: Issue): boolean {
  // Exactly one session per issue; never re-run a session that already
  // produced a PR. A `developing` card is only re-workable when its last run
  // failed (blocked_reason set) — otherwise the run may still be live.
  return (
    issue.state === 'backlog' ||
    issue.state === 'refinement' ||
    (issue.state === 'developing' && Boolean(issue.blockedReason))
  );
}

export { setSessionId, getIssue };
