import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { createGithubIssue, type GhRepo } from '../github';
import { remember } from '../knowledge';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Resolves "devhub" to its owner by listing the operator's repos. Prefers an
// explicit params.owner when the model extracted one.
async function resolveOwner(repo: string, explicitOwner: string | null, token: string): Promise<string | null> {
  if (explicitOwner) return explicitOwner;
  try {
    const res = await fetch('https://api.github.com/user/repos?per_page=100', { headers: ghHeaders(token) });
    if (!res.ok) return null;
    const repos = (await res.json()) as GhRepo[];
    const match = repos.find((r) => r.name.toLowerCase() === repo.toLowerCase());
    return match ? match.owner.login : null;
  } catch {
    return null;
  }
}

registerSkill(
  {
    id: 'create-issue',
    name: 'Create Issue',
    description: 'File a new GitHub issue in a repo',
    action: 'create',
    triggers: ['create', 'file', 'new issue', 'open issue'],
    requiredParams: ['repo', 'issueTitle'],
    optionalParams: ['owner', 'description', 'title', 'body'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const repo = (ctx.params.repo as string) || (ctx.params.name as string) || '';
    const title = (ctx.params.issueTitle as string) || (ctx.params.title as string) || '';
    const body =
      (ctx.params.description as string) || (ctx.params.body as string) || ctx.input;
    const explicitOwner =
      typeof ctx.params.owner === 'string' && ctx.params.owner.trim()
        ? (ctx.params.owner as string).trim()
        : null;

    if (!repo.trim() || !title.trim()) {
      return { success: false, summary: 'Need a repo and a title to file the issue (repo + issueTitle).' };
    }

    ctx.onStatus(`Filing issue in ${repo}...`);
    const owner = await resolveOwner(repo.trim(), explicitOwner, ctx.token);
    if (!owner) {
      return {
        success: false,
        summary: `Repo "${repo}" not found in your accessible repos — check the name or pass params.owner explicitly.`,
      };
    }

    try {
      const created = await createGithubIssue(owner, repo.trim(), title.trim(), body, ctx.token);
      remember(
        'create',
        `Filed issue in ${owner}/${repo}: ${title} (${created.htmlUrl})`,
        { owner, repo, title, url: created.htmlUrl, number: created.number },
        ctx.actionId
      );
      return { success: true, summary: `Issue opened: ${created.htmlUrl}`, details: created };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { success: false, summary: reason };
    }
  }
);
