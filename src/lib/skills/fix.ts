import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { getIssue, appendEvent, setSessionId, setResult, storeKnowledge } from '../store';
import { buildDevelopPrompt, extractPrUrl, runDevelop, type OpencodeEvent } from '../opencode';
import { publishIssue, publishOpencodeEvent } from '../sse';
import { mirrorComment } from '../utils';
import { setIssueStateLabels } from '../github';

registerSkill(
  {
    id: 'fix',
    name: 'Fix Issue',
    description: 'Resolve a problem and open a PR',
    action: 'fix',
    triggers: ['fix', 'resolve', 'bug', 'issue', 'error', 'broken'],
    requiredParams: ['issueId'],
    optionalParams: ['command'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const issueId = ctx.params.issueId as number;
    const issue = getIssue(issueId);
    if (!issue) {
      return { success: false, summary: `Issue #${issueId} not found` };
    }

    ctx.onStatus(`Fixing issue #${issue.number} in ${issue.repo}...`);

    try {
      const prompt = buildDevelopPrompt(issue, (ctx.params.command as string) || '');
      const sessionIds: string[] = [];

      const onEvent = (event: OpencodeEvent) => {
        appendEvent(issue.id, 'opencode', event);
        publishOpencodeEvent(issue.id, event);
        ctx.onEvent(event);
      };

      const text = await runDevelop(prompt, onEvent, ctx.models, (sid) => {
        sessionIds.push(sid);
        setSessionId(issue.id, sid);
        ctx.onStartSession(sid);
      });

      const prUrl = extractPrUrl(text);
      if (prUrl) {
        setResult(issue.id, 'pr', prUrl, text);
        const updated = getIssue(issue.id);
        if (updated) publishIssue(updated);
        try { await setIssueStateLabels(issue.owner, issue.repo, issue.number, 'pr', ctx.token); } catch {}
        void mirrorComment(issue, `DevHub opened a pull request: ${prUrl}`, ctx.token);

        storeKnowledge('fix',
          `Fixed issue #${issue.number} in ${issue.repo}: ${prUrl}`,
          { issueId: issue.id, owner: issue.owner, repo: issue.repo, number: issue.number, prUrl },
          ctx.actionId
        );

        return { success: true, summary: `PR opened: ${prUrl}`, sessionIds };
      } else {
        setResult(issue.id, 'blocked', null, text);
        const updated = getIssue(issue.id);
        if (updated) publishIssue(updated);

        storeKnowledge('fix',
          `Attempted issue #${issue.number} in ${issue.repo}: blocked`,
          { issueId: issue.id, owner: issue.owner, repo: issue.repo, number: issue.number },
          ctx.actionId
        );

        return { success: false, summary: text.slice(0, 500), sessionIds };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      appendEvent(issue.id, 'error', { message: reason });
      setResult(issue.id, 'blocked', null, `CANNOT FULFILL: ${reason}`);
      const updated = getIssue(issue.id);
      if (updated) publishIssue(updated);
      return { success: false, summary: reason };
    }
  }
);
