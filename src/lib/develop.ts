import { appendEvent, getIssue, setDefaultModel, setIssueState, setResult, setSessionId, type Issue } from './store';
import {
  buildDevelopPrompt,
  extractPrUrl,
  resolveModels,
  runDevelop,
  type OpencodeEvent,
  type OpencodeModel,
} from './opencode';
import { isIssueClosedOnGitHub, setIssueStateLabels } from './github';
import { publishIssue, publishOpencodeEvent } from './sse';
import { mirrorComment } from './utils';
import { buildValidatePrompt, parseValidationResult } from './validate';

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

  const models = resolveModels(selectedModel);
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

      const finalState = alreadyResolved ? 'closed' : 'blocked';
      const updated = setResult(issue.id, finalState, null, text);
      if (updated) publishIssue(updated);
      void mirrorLabels(issue, finalState, token);
      if (alreadyResolved) {
        void mirrorComment(
          issue,
          `DevHub determined this issue is already resolved.\n\n${text.slice(0, 4000)}`,
          token
        );
      } else {
        void mirrorComment(
          issue,
          `DevHub finished but did not open a PR.\n\n${text.slice(0, 4000)}`,
          token
        );
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'error', { message: reason });
    const blocked = setResult(issue.id, 'blocked', null, `CANNOT FULFILL: ${reason}`);
    if (blocked) publishIssue(blocked);
    void mirrorLabels(issue, 'blocked', token);
    void mirrorComment(issue, `DevHub could not fulfill this issue: ${reason}`, token);
  }
}

// Staged develop: validates the issue first, then proceeds to develop if validation passes.
// Intended to be called fire-and-forget from the API route.
export async function startStagedDevelop(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  // Phase 1: Validate
  const originalState = issue.state;
  const validating = setIssueState(issue.id, 'refinement');
  if (validating) publishIssue(validating);
  void mirrorLabels(issue, 'refinement', token);
  void mirrorComment(issue, 'DevHub validating this issue...', token);

  try {
    const models = resolveModels(selectedModel);
    const validatePrompt = buildValidatePrompt(issue);
    
    appendEvent(issue.id, 'validation', { status: 'started' });
    
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'validation-event', event);
    };
    
    const validateText = await runDevelop(validatePrompt, onEvent, models);
    const result = parseValidationResult(validateText);
    
    appendEvent(issue.id, 'validation', { 
      status: 'completed', 
      ready: result.ready, 
      summary: result.summary 
    });

    if (!result.ready) {
      // Validation failed - restore original state with feedback
      const restored = setResult(issue.id, originalState, null, `Validation: ${result.summary}`);
      if (restored) publishIssue(restored);
      void mirrorLabels(issue, originalState, token);
      void mirrorComment(issue, `DevHub validation found issues:\n\n${result.summary}`, token);
      return;
    }

    // Validation passed - proceed to develop
    void mirrorComment(issue, `DevHub validation passed: ${result.summary}`, token);
    
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'validation-error', { message: reason });
    const restored = setResult(issue.id, originalState, null, `Validation failed: ${reason}`);
    if (restored) publishIssue(restored);
    void mirrorLabels(issue, originalState, token);
    void mirrorComment(issue, `DevHub validation failed: ${reason}`, token);
    return;
  }

  // Phase 2: Implement (reuse existing develop flow)
  await startDevelop(issue, command, token, selectedModel);
}

export function canDevelop(issue: Issue): boolean {
  // Exactly one session per issue; never re-run a session that already produced a PR.
  return issue.state === 'backlog' || issue.state === 'refinement' || issue.state === 'blocked';
}

export { setSessionId, getIssue };
