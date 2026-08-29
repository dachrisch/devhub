import { appendEvent, getIssue, setIssueState, setResult, setSessionId, type Issue } from './store';
import { buildDevelopPrompt, defaultModels, extractPrUrl, runDevelop, type OpencodeEvent } from './opencode';
import { publishIssue, publishOpencodeEvent } from './sse';

// Kicks off (and runs to completion) a "develop this" session for an issue.
// Intended to be called fire-and-forget from the API route: it owns all
// server-side state transitions and broadcasts them over SSE.
export async function startDevelop(issue: Issue, command: string): Promise<void> {
  const developing = setIssueState(issue.id, 'developing');
  if (developing) publishIssue(developing);

  try {
    const prompt = buildDevelopPrompt(issue, command);
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'opencode', event);
      publishOpencodeEvent(issue.id, event);
    };
    const text = await runDevelop(prompt, onEvent, defaultModels(), (sessionId) => {
      setSessionId(issue.id, sessionId);
      const withSession = getIssue(issue.id);
      if (withSession) publishIssue(withSession);
    });

    const prUrl = extractPrUrl(text);
    const updated = prUrl
      ? setResult(issue.id, 'pr', prUrl, text)
      : setResult(issue.id, 'blocked', null, text);
    if (updated) publishIssue(updated);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'error', { message: reason });
    const blocked = setResult(issue.id, 'blocked', null, `CANNOT FULFILL: ${reason}`);
    if (blocked) publishIssue(blocked);
  }
}

export function canDevelop(issue: Issue): boolean {
  // Exactly one session per issue; never re-run a session that already produced a PR.
  return issue.state === 'backlog' || issue.state === 'blocked';
}

export { setSessionId, getIssue };
