import type { Issue, IssueState } from './types';

// A work item can only be handed to the develop pipeline from these states
// (mirrors `canDevelop`). The hand-select list must never offer a target that
// would immediately 409.
export const WORKABLE_STATES: ReadonlySet<IssueState> = new Set(['backlog', 'refinement', 'developing']);

const MAX_RESULTS = 8;

// Fuzzy hand-select candidates for a clarification chip: scoped to the
// resolved repo(s) when known (never guessed), restricted to workable states,
// then matched against the free-text query (title / owner / repo / number).
export function filterIssueCandidates(issues: Issue[], repos: string[], query: string, limit = MAX_RESULTS): Issue[] {
  const scope = new Set(repos);
  const needle = query.trim().toLowerCase();
  return issues
    .filter((i) => i.source !== 'request')
    .filter((i) => WORKABLE_STATES.has(i.state))
    .filter((i) => scope.size === 0 || scope.has(`${i.owner}/${i.repo}`))
    .filter(
      (i) =>
        !needle ||
        `${i.title} ${i.owner}/${i.repo} #${i.number}`.toLowerCase().includes(needle)
    )
    .slice(0, limit);
}
