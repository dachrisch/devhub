import type { Issue } from './types';
import { commentOnIssue } from './github';

export async function mirrorComment(issue: Issue, body: string, token: string): Promise<void> {
  try {
    await commentOnIssue(issue.owner, issue.repo, issue.number, body, token);
  } catch {
    /* non-fatal */
  }
}
