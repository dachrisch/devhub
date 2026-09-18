import {
  appendEvent,
  clearBlockedReason,
  ensureRuns,
  getEvents,
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
  buildVerifyPrompt,
  ensureWorktree,
  extractBaseSha,
  extractPrUrl,
  getAvailableModels,
  parseVerifyResult,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type DevelopCarryOver,
  type IdeaContext,
  type OpencodeEvent,
  type OpencodeModel,
  type VerifyVerdict,
} from './opencode';
import { checkPrBase, isIssueClosedOnGitHub, setIssueStateLabels, updateIssueBody } from './github';
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

// Issues with a verification run currently in flight. Verification owns no
// develop_runs row (like refinement), so without this two "Work" clicks could
// stack duplicate reviewer sessions on the same PRs. Process-local: single
// prod server, fire-and-forget.
const liveVerifyRuns = new Set<number>();

// Reads the testable acceptance criteria from the latest completed
// refinement event. Empty when the issue was refined before criteria were
// recorded — the verifier skips with a trace in that case.
export function readAcceptanceCriteria(issueId: number): string[] {
  const events = getEvents(issueId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'refinement') continue;
    const p = e.payload as { status?: unknown; acceptanceCriteria?: unknown } | null;
    if (!p || typeof p !== 'object' || p.status !== 'completed') continue;
    if (!Array.isArray(p.acceptanceCriteria)) return [];
    return p.acceptanceCriteria.map((c) => String(c ?? '').trim()).filter((c) => c.length > 0);
  }
  return [];
}

export interface VerificationResult {
  allPass: boolean;
  skipped: boolean;
  duplicate: boolean;
  summary: string;
  verdicts: VerifyVerdict[];
}

// Independent read-only review of the opened PRs against the refinement's
// acceptance criteria. Never auto-passes: an inconclusive reply or a session
// error blocks like a failed criterion, and the next Work click retries.
async function runVerification(
  issue: Issue,
  prUrls: string[],
  selectedModel?: OpencodeModel | null
): Promise<VerificationResult> {
  if (liveVerifyRuns.has(issue.id)) {
    return { allPass: false, skipped: false, duplicate: true, summary: '', verdicts: [] };
  }
  liveVerifyRuns.add(issue.id);
  try {
    return await runVerificationInner(issue, prUrls, selectedModel);
  } finally {
    liveVerifyRuns.delete(issue.id);
  }
}

async function runVerificationInner(
  issue: Issue,
  prUrls: string[],
  selectedModel?: OpencodeModel | null
): Promise<VerificationResult> {
  const criteria = readAcceptanceCriteria(issue.id);
  if (criteria.length === 0) {
    appendEvent(issue.id, 'verification', {
      status: 'skipped',
      reason: 'no acceptance criteria recorded (refined before verification existed)',
    });
    return { allPass: true, skipped: true, duplicate: false, summary: 'no acceptance criteria recorded', verdicts: [] };
  }
  appendEvent(issue.id, 'verification', { status: 'started', criteria: criteria.length, prUrls });

  try {
    const models = sanitizeModels(resolveModels(selectedModel), await getAvailableModels());
    const prompt = buildVerifyPrompt(issue, criteria, prUrls);
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'verification-event', event);
      publishOpencodeEvent(issue.id, event);
    };
    const text = await runDevelop(prompt, onEvent, models, undefined, ENV.opencodeRefinementPollTimeoutMs);
    const outcome = parseVerifyResult(text, criteria.length);
    appendEvent(issue.id, 'verification', {
      status: outcome.inconclusive ? 'inconclusive' : 'completed',
      allPass: outcome.allPass,
      summary: outcome.summary,
      verdicts: outcome.verdicts,
    });
    return {
      allPass: outcome.allPass,
      skipped: false,
      duplicate: false,
      summary: outcome.summary,
      verdicts: outcome.verdicts,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const summary = `Verification errored: ${reason}`;
    appendEvent(issue.id, 'verification', { status: 'error', allPass: false, summary, verdicts: [] });
    return { allPass: false, skipped: false, duplicate: false, summary, verdicts: [] };
  }
}

// Surfaces the latest verification failure to the next develop attempt so the
// implementer sees what to fix instead of re-shipping the same diffs. A newer
// passing verification supersedes older failures; issues without any
// verification history get no extra context.
function verificationContextForRetry(issueId: number): string | null {
  const events = getEvents(issueId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'verification' || !e.payload || typeof e.payload !== 'object') continue;
    const p = e.payload as { status?: unknown; allPass?: unknown; summary?: unknown };
    if (p.status === 'completed' && p.allPass === true) return null;
    if (
      (p.status === 'completed' || p.status === 'inconclusive' || p.status === 'error') &&
      typeof p.summary === 'string' &&
      p.summary.trim().length > 0
    ) {
      return `## Previous verification failure — address every item below before opening a PR\n${p.summary.slice(0, 2000)}`;
    }
  }
  return null;
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
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
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
  // Retry context: a previous verification failure is prepended to the
  // operator command so the implementer sees what to fix instead of
  // re-shipping the same diffs.
  const retryContext = verificationContextForRetry(issue.id);
  const effectiveCommand = retryContext ? `${command}\n\n${retryContext}`.trim() : command;
  let carryOver: DevelopCarryOver | null = null;
  // Rebuild carry-over from runs that already produced PRs (retry path).
  for (const r of runs) {
    if (r.prUrl && (r.state === 'pr' || r.state === 'merged' || r.state === 'released')) {
      carryOver = { prUrl: r.prUrl, summary: (r.resultText ?? '').slice(0, 2000) };
    }
  }

  try {
    for (const [index, run] of runs.entries()) {
      const fresh = getRunsForIssue(issue.id).find((r) => r.id === run.id) ?? run;
      // Skip runs that already produced a PR — retry touches only failed/missing.
      if (fresh.state === 'pr' || fresh.state === 'merged' || fresh.state === 'released') {
        if (fresh.prUrl) carryOver = { prUrl: fresh.prUrl, summary: (fresh.resultText ?? '').slice(0, 2000) };
        continue;
      }
      await runSingleChildRun(
        issue,
        fresh,
        effectiveCommand,
        token,
        models,
        projectId,
        carryOver,
        (next) => {
          carryOver = next;
        },
        index === 0 ? (ideaContext ?? null) : null
      );
      const after = getRunsForIssue(issue.id).find((r) => r.id === run.id);
      // A failed run stops the chain; the card stays `developing` with a
      // repo-named blocked_reason and the next Work click retries only it.
      if (after?.state === 'failed' || after?.blockedReason) return;
      if (after?.prUrl) carryOver = { prUrl: after.prUrl, summary: (after.resultText ?? '').slice(0, 2000) };
    }

    const finalRuns = getRunsForIssue(issue.id);
    const prUrls = finalRuns.map((r) => r.prUrl).filter((u): u is string => Boolean(u));
    if (prUrls.length > 0 && prUrls.length === finalRuns.length) {
      // Acceptance gate: an independent read-only session checks every
      // criterion against the PR diffs before the card may advance to `pr`.
      // Unmet criteria reset the runs to `failed` (PR URLs kept) so the next
      // Work click re-develops with the verdicts as context instead of
      // re-verifying the same diffs in a loop.
      const verification = await runVerification(issue, prUrls, selectedModel);
      if (verification.duplicate) return;
      if (!verification.allPass) {
        for (const r of finalRuns) {
          updateRun(r.id, {
            state: 'failed',
            blockedReason: `Verification failed: ${verification.summary}`.slice(0, 500),
          });
          publishRun(r.id, issue.id);
        }
        const reason = `AC verification failed:\n${verification.summary}`;
        appendEvent(issue.id, 'error', { message: reason });
        const updated = setBlockedReason(issue.id, reason.slice(0, 500));
        if (updated) publishIssue(updated);
        const failedLines = verification.verdicts
          .filter((v) => !v.pass)
          .map((v) => `- AC ${v.ac}: ${v.evidence || 'no evidence'}`)
          .join('\n');
        void mirrorComment(
          issue,
          `DevHub verified ${prUrls.length} pull request(s) against the acceptance criteria — ${verification.verdicts.filter((v) => v.pass).length}/${verification.verdicts.length} passed${failedLines ? `:\n\n${failedLines}` : '.'}\n\nThe next Work click re-develops with these findings as context.`,
          token
        );
        return;
      }
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
  onCarryOver: (next: DevelopCarryOver) => void,
  ideaContext: IdeaContext | null = null
): Promise<void> {
  updateRun(run.id, { state: 'developing', blockedReason: null });
  publishRun(run.id, issue.id);
  const onEvent = (event: OpencodeEvent) => {
    appendEvent(issue.id, 'opencode', { ...event, runId: run.id, role: run.role });
    publishOpencodeEvent(issue.id, event);
  };
  try {
    const worktree = await ensureWorktree(run.repoOwner, run.repoName, `${issue.id}-${run.role}`);
    const prompt = buildDevelopPrompt(
      issue,
      command,
      worktree,
      { role: run.role, repoOwner: run.repoOwner, repoName: run.repoName, projectId },
      carryOver,
      ideaContext
    );
    const text = await runDevelop(
      prompt,
      onEvent,
      models,
      (sessionId) => {
        updateRun(run.id, { sessionId });
        publishRun(run.id, issue.id);
        setSessionId(issue.id, sessionId);
        const withSession = getIssue(issue.id);
        if (withSession) publishIssue(withSession);
      },
      undefined,
      worktree.directory
    );

    const prUrl = extractPrUrl(text);
    if (prUrl) {
      const baseSha = extractBaseSha(text);
      updateRun(run.id, { state: 'pr', prUrl, resultText: text.slice(0, 8000), blockedReason: null, baseSha });
      publishRun(run.id, issue.id);
      // Base-branch gate (wrong-base branches, e.g. devhub#223 → PR #225
      // shipped 3 foreign commits and merge-conflicted): the PR must contain
      // only this run's work. A polluted branch fails the run — retryable,
      // since the next attempt renormalizes the base per step 0a and
      // force-pushes to this same PR — instead of shipping foreign commits.
      // Transport/API blips fail open with a trace so a GitHub hiccup never
      // kills a good run.
      try {
        const base = await checkPrBase(run.repoOwner, run.repoName, prUrl, token);
        if (!base.ok) {
          const reason = `Wrong base branch: ${base.reason}. Reset to origin/master (step 0a) and push --force-with-lease to update this PR, then end with its URL.`;
          appendEvent(issue.id, 'error', { message: reason, runId: run.id, role: run.role });
          updateRun(run.id, { state: 'failed', blockedReason: reason.slice(0, 500) });
          publishRun(run.id, issue.id);
          const updated = setBlockedReason(issue.id, `${run.role}: ${reason}`.slice(0, 500));
          if (updated) publishIssue(updated);
          void mirrorComment(
            issue,
            `DevHub opened ${prUrl} but its base is wrong:\n\n${base.reason}\n\nThe next Work click retries from a clean origin/master and updates this PR.`,
            token
          );
          return;
        }
      } catch (err) {
        const skipped = err instanceof Error ? err.message : String(err);
        appendEvent(issue.id, 'base-check-skipped', { message: skipped, runId: run.id, role: run.role });
      }
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
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
): Promise<void> {
  if (liveRefinementRuns.has(issue.id)) return;
  liveRefinementRuns.add(issue.id);
  try {
    await runRefinementInner(issue, command, token, selectedModel, ideaContext);
  } finally {
    liveRefinementRuns.delete(issue.id);
  }
}

async function runRefinementInner(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
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
      // Testable acceptance criteria for the post-develop verifier session.
      // Stored on the event (not a column): the verifier reads the latest
      // completed refinement the same way the board reads the transcript.
      acceptanceCriteria: result.acceptanceCriteria,
    });

    // The verifier session checks each criterion against the PR diff, so an
    // issue is only developable when at least one testable criterion exists.
    // A ready=true without criteria means the refiner skipped its
    // instructions — hold the card for another refinement pass.
    const ready = result.ready && result.acceptanceCriteria.length > 0;

    if (!ready) {
      const feedback = result.ready
        ? 'No testable acceptance criteria were produced — re-run Work to refine again with concrete, checkable conditions.'
        : result.blockingQuestions.length > 0
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
  await startDevelop(fresh, command, token, selectedModel, ideaContext);
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
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
): Promise<void> {
  if (issue.state === 'backlog') {
    const moved = setIssueState(issue.id, 'refinement');
    if (moved) publishIssue(moved);
    void mirrorLabels(issue, 'refinement', token);
    return await runRefinement(moved ?? issue, command, token, selectedModel, ideaContext);
  }

  if (issue.state === 'refinement') {
    return await runRefinement(issue, command, token, selectedModel, ideaContext);
  }

  if (issue.state === 'developing') {
    // Only reachable when a previous run failed (see canDevelop): a live run
    // must never get a concurrent duplicate session in the same worktree.
    clearBlockedReason(issue.id);
    return await startDevelop(issue, command, token, selectedModel, ideaContext);
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
