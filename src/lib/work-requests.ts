// Local work requests: a free-text command against a resolved repo that has no
// matching GitHub issue. The thread runs the normal develop pipeline against a
// local `request` work item, so the agent can just start working.

const TITLE_MAX = 120;
const PLACEHOLDER = 'New work request';

// First meaningful line of the command, whitespace-collapsed and with a
// leading markdown heading marker stripped, capped for the work-item title.
export function deriveWorkRequestTitle(input: string, max = TITLE_MAX): string {
  const line = input
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const title = (line ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  if (!title) return PLACEHOLDER;
  return title.length > max ? title.slice(0, max) : title;
}
