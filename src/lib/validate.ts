import { ENV } from './env';
import type { Issue } from './types';

export interface RefineResult {
  ready: boolean;
  summary: string;
  improvedBody: string | null;
  blockingQuestions: string[];
}

// Refinement-stage prompt: assess the issue AND, when possible, produce an
// improved version so the develop stage can start without user input.
export function buildRefinePrompt(issue: Issue): string {
  const repoPath = `${ENV.openWorkspaceRoot}/${issue.repo}`;
  return [
    `You are refining a GitHub issue for readiness on a personal dev command board (DevHub).`,
    `Assess the issue AND produce an improved version if possible.`,
    ``,
    `## Repository`,
    `Repository path: ${repoPath}`,
    `Owner: ${issue.owner}   Repo: ${issue.repo}   Issue #${issue.number}`,
    `Issue URL: ${issue.htmlUrl}`,
    ``,
    `## Issue`,
    `Title: ${issue.title}`,
    `Body:`,
    issue.body?.trim() || '(no description)',
    ``,
    `## Assessment Criteria`,
    `1. **Clear scope**: Is the goal well-defined?`,
    `2. **Acceptance criteria**: Are there testable conditions for completion?`,
    `3. **Technical feasibility**: Is this achievable with the repo's existing stack?`,
    `4. **No major ambiguities**: Are there blocking questions that need human answers?`,
    ``,
    `## Response Format`,
    `Respond with EXACTLY ONE JSON object (no markdown fences):`,
    `{`,
    `  "ready": true/false,`,
    `  "summary": "brief assessment",`,
    `  "improvedBody": "full improved issue body" or null if already ready,`,
    `  "blockingQuestions": ["question that needs human answer"] or empty array`,
    `}`,
    ``,
    `Rules:`,
    `- If already clear and ready: ready=true, improvedBody=null, blockingQuestions=[]`,
    `- If needs minor improvements (missing criteria, vague scope that can be inferred): ready=true, write improved body, blockingQuestions=[]`,
    `- If has truly blocking questions (architecture decisions, business requirements, missing info): ready=false, list in blockingQuestions`,
    `- improvedBody must be a complete GitHub issue body (markdown), not a diff`,
  ].join('\n');
}

export function parseRefineResult(text: string): RefineResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        ready: Boolean(parsed.ready),
        summary: String(parsed.summary ?? text),
        improvedBody: typeof parsed.improvedBody === 'string' && parsed.improvedBody.trim() ? parsed.improvedBody : null,
        blockingQuestions: Array.isArray(parsed.blockingQuestions)
          ? parsed.blockingQuestions.map(String)
          : [],
      };
    } catch {
      /* fall through to the plain-text fallback */
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('READY:')) {
    return { ready: true, summary: trimmed.slice(6).trim(), improvedBody: null, blockingQuestions: [] };
  }
  return { ready: false, summary: trimmed, improvedBody: null, blockingQuestions: [] };
}
