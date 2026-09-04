import {
  appendEvent,
  clearBlockedReason,
  getIssue,
  setBlockedReason,
  setDefaultModel,
  setIssueBody,
  setIssueState,
  setResult,
  setSessionId,
  type Issue,
} from './store';
import {
  buildDevelopPrompt,
  extractPrUrl,
  getAvailableModels,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type OpencodeEvent,
  type OpencodeModel,
} from './opencode';
import { isIssueClosedOnGitHub, setIssueStateLabels, updateIssueBody } from './github';
import { publishIssue, publishOpencodeEvent } from './sse';
import { mirrorComment } from './utils';
import { buildRefinePrompt, parseRefineResult } from './validate';
import { ENV } from './env';

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

// Kicks off (and runs to completion) a "develop this" session for an issue.
// Intended to be called fire-and-forget from the API route: it owns all
// server-side state transitions and broadcasts them over SSE. `token` is the
// operator's GitHub OAuth token used for state mirroring on the issue.
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

  try {
    const prompt = buildDevelopPrompt(issue, command);
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'opencode', event);
      publishOpencodeEvent(issue.id, event);
    };
    const text = await runDevelop(prompt, onEvent, models, (sessionId) => {
      setSessionId(issue.id, sessionId);
      const withSession = getIssue(issue.id);
      if (withSession) publishIssue(withSession);
    });

    const prUrl = extractPrUrl(text);
    if (prUrl) {
      const updated = setResult(issue.id, 'pr', prUrl, text);
      if (updated) publishIssue(updated);
      void mirrorLabels(issue, 'pr', token);
      void mirrorComment(issue, `DevHub opened a pull request: ${prUrl}`, token);
    } else {
      // No PR URL — determine if the agent assessed the issue as already
      // resolved (closed on GitHub or has a linked PR) or if it truly failed.
      const alreadyResolved =
        text.includes('ALREADY RESOLVED') ||
        (await isIssueClosedOnGitHub(issue.owner, issue.repo, issue.number, token)) ||
        Boolean(issue.linkedPrUrl);

      if (alreadyResolved) {
        const updated = setResult(issue.id, 'closed', null, text);
        if (updated) publishIssue(updated);
        void mirrorLabels(issue, 'closed', token);
        void mirrorComment(
          issue,
          `DevHub determined this issue is already resolved.\n\n${text.slice(0, 4000)}`,
          token
        );
      } else {
        // Stage failure (devhub#132): stay in `developing`, surface what's
        // needed — the next "Work" click resumes from here.
        const updated = setBlockedReason(issue.id, text.slice(0, 500));
        if (updated) publishIssue(updated);
        void mirrorComment(issue, `DevHub finished but did not open a PR.\n\n${text.slice(0, 4000)}`, token);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'error', { message: reason });
    const updated = setBlockedReason(issue.id, `CANNOT FULFILL: ${reason}`);
    if (updated) publishIssue(updated);
    void mirrorComment(issue, `DevHub could not fulfill this issue: ${reason}`, token);
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
    const prompt = buildRefinePrompt(issue);
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'refinement-event', event);
      publishOpencodeEvent(issue.id, event);
    };

    const text = await runDevelop(prompt, onEvent, models, undefined, ENV.opencodeRefinementPollTimeoutMs);
    const result = parseRefineResult(text);

    appendEvent(issue.id, 'refinement', {
      status: 'completed',
      ready: result.ready,
      summary: result.summary,
      blockingQuestions: result.blockingQuestions,
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
