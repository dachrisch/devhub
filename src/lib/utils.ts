import type { Issue } from './types';
import { commentOnIssue } from './github';

export async function mirrorComment(issue: Issue, body: string, token: string): Promise<void> {
  // Local `request` work items have no GitHub issue to comment on.
  if (issue.source === 'request') return;
  try {
    await commentOnIssue(issue.owner, issue.repo, issue.number, body, token);
  } catch {
    /* non-fatal */
  }
}
