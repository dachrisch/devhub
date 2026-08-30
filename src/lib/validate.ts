import { ENV } from './env';
import type { Issue } from './types';
import { appendEvent, setIssueState, setResult } from './store';
import { resolveModels, runDevelop, type OpencodeEvent } from './opencode';
import { publishIssue } from './sse';
import { mirrorComment } from './utils';
import { startDevelop } from './develop';

export function buildValidatePrompt(issue: Issue): string {
  const repoPath = `${ENV.openWorkspaceRoot}/${issue.repo}`;
  
  const parts = [
    `You are validating a GitHub issue for readiness on a personal dev command board (DevHub).`,
    `Your job is to assess whether this issue is clear enough to be implemented.`,
    ``,
    `## Repository`,
    `Repository path: ${repoPath}`,
    `Owner: ${issue.owner}   Repo: ${issue.repo}   Issue #${issue.number}`,
    `Issue URL: ${issue.htmlUrl}`,
    ``,
    `## Issue`,
    `Title: ${issue.title}`,
    ``,
    `Body:`,
    issue.body?.trim() ? issue.body.trim() : '(no description)',
    ``,
    `## Validation Criteria`,
    `Assess the issue against these criteria:`,
    `1. **Clear scope**: Is the goal well-defined? Can you tell what needs to be done?`,
    `2. **Acceptance criteria**: Are there testable conditions for completion?`,
    `3. **Technical feasibility**: Is this achievable with the repo's existing stack?`,
    `4. **No major ambiguities**: Are there blocking questions that need answers?`,
    ``,
    `## Response Format`,
    `Respond with EXACTLY ONE of:`,
    `- "READY: <brief summary of what will be implemented>" if the issue is clear enough to proceed`,
    `- "NEEDS_WORK: <specific improvements needed>" if the issue needs refinement before implementation`,
    ``,
    `Be concise. Focus on whether a developer (human or AI) could start working on this immediately.`,
  ];

  return parts.join('\n');
}

export function parseValidationResult(text: string): { ready: boolean; summary: string } {
  const trimmed = text.trim();
  
  if (trimmed.startsWith('READY:')) {
    return { ready: true, summary: trimmed.slice(6).trim() };
  }
  
  if (trimmed.startsWith('NEEDS_WORK:')) {
    return { ready: false, summary: trimmed.slice(11).trim() };
  }
  
  // Fallback: check for keywords
  const lower = trimmed.toLowerCase();
  if (lower.includes('ready') && !lower.includes('needs work')) {
    return { ready: true, summary: trimmed };
  }
  
  return { ready: false, summary: trimmed };
}

export async function startValidation(issue: Issue, token: string): Promise<void> {
  if (issue.state !== 'backlog' && issue.state !== 'refinement') {
    appendEvent(issue.id, 'validation', { status: 'skipped', reason: `issue in '${issue.state}' state` });
    return;
  }

  try {
    const models = resolveModels();
    const prompt = buildValidatePrompt(issue);
    
    appendEvent(issue.id, 'validation', { status: 'started' });
    
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'validation-event', event);
    };
    
    const text = await runDevelop(prompt, onEvent, models);
    const result = parseValidationResult(text);
    
    appendEvent(issue.id, 'validation', { 
      status: 'completed', 
      ready: result.ready, 
      summary: result.summary 
    });

    if (result.ready) {
      const updated = setIssueState(issue.id, 'backlog');
      if (updated) publishIssue(updated);
      void startDevelop(issue, '', token);
    } else {
      const updated = setResult(issue.id, 'refinement', null, result.summary);
      if (updated) publishIssue(updated);
    }
    
    void mirrorComment(issue, `DevHub validation: ${result.ready ? 'READY' : 'NEEDS_WORK'}\n${result.summary}`, token);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'validation-error', { message: reason });
    void mirrorComment(issue, `DevHub validation failed: ${reason}`, token);
  }
}
