import { ENV } from './env';
import { isRepoScope, type Issue, type RepoScope } from './types';

export interface RefineResult {
  ready: boolean;
  summary: string;
  improvedBody: string | null;
  blockingQuestions: string[];
  scope: RepoScope;
  infraFirst: boolean;
}

// Refinement-stage prompt: assess the issue AND, when possible, produce an
// improved version so the develop stage can start without user input.
// Phase 3 (devhub#167): also decides the repo scope (`service`|`infra`|`both`)
// and run order (`infra_first`) for sequential per-repo child runs.
export function buildRefinePrompt(issue: Issue, project?: { name: string; config?: unknown } | null): string {
  const repoPath = `${ENV.openWorkspaceRoot}/${issue.repo}`;
  const infraRepo = ENV.infraRepo ? `${ENV.infraRepo.owner}/${ENV.infraRepo.name}` : '(not configured)';
  const projectBlock = project
    ? [`## Project context`, `Project: ${project.name}`, `Config: ${JSON.stringify(project.config ?? {})}`, ``]
    : [];
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
    ...projectBlock,
    `## Assessment Criteria`,
    `1. **Clear scope**: Is the goal well-defined?`,
    `2. **Acceptance criteria**: Are there testable conditions for completion?`,
    `3. **Technical feasibility**: Is this achievable with the repo's existing stack?`,
    `4. **No major ambiguities**: Are there blocking questions that need human answers?`,
    ``,
    `## Repos in play`,
    `Service repo: ${issue.owner}/${issue.repo}`,
    `Shared infra repo: ${infraRepo}`,
    ``,
    `## Response Format`,
    `Respond with EXACTLY ONE JSON object (no markdown fences):`,
    `{`,
    `  "ready": true/false,`,
    `  "summary": "brief assessment",`,
    `  "improvedBody": "full improved issue body" or null if already ready,`,
    `  "blockingQuestions": ["question that needs human answer"] or empty array,`,
    `  "scope": "service" | "infra" | "both",`,
    `  "infra_first": true/false (run order when scope is "both")`,
    `}`,
    ``,
    `Rules:`,
    `- If already clear and ready: ready=true, improvedBody=null, blockingQuestions=[]`,
    `- If needs minor improvements (missing criteria, vague scope that can be inferred): ready=true, write improved body, blockingQuestions=[]`,
    `- If has truly blocking questions (architecture decisions, business requirements, missing info): ready=false, list in blockingQuestions`,
    `- improvedBody must be a complete GitHub issue body (markdown), not a diff`,
    `- scope: "service" when only the service repo needs changes, "infra" when`,
    `  only the shared infra repo does, "both" when the feature spans both.`,
    `  Default to "service" when unsure or when no infra repo is configured.`,
    `- infra_first: true only when scope is "both" and the infra change must`,
    `  land first (e.g. infra provides config the service consumes).`,
  ].join('\n');
}

export function parseRefineResult(text: string): RefineResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const scope = isRepoScope(parsed.scope) ? parsed.scope : 'service';
      return {
        ready: Boolean(parsed.ready),
        summary: String(parsed.summary ?? text),
        improvedBody: typeof parsed.improvedBody === 'string' && parsed.improvedBody.trim() ? parsed.improvedBody : null,
        blockingQuestions: Array.isArray(parsed.blockingQuestions)
          ? parsed.blockingQuestions.map(String)
          : [],
        scope,
        infraFirst: scope === 'both' ? parsed.infra_first === true : false,
      };
    } catch {
      /* fall through to the plain-text fallback */
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('READY:')) {
    return { ready: true, summary: trimmed.slice(6).trim(), improvedBody: null, blockingQuestions: [], scope: 'service', infraFirst: false };
  }
  return { ready: false, summary: trimmed, improvedBody: null, blockingQuestions: [], scope: 'service', infraFirst: false };
}
