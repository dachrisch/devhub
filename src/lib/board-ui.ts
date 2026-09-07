import type { Issue, IssueState } from './types';

export const REPO_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#bc8cff',
  '#39c5cf',
  '#ff7b72',
  '#a5d6ff',
  '#7ee787',
  '#ffa657',
];

export function repoColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return REPO_COLORS[h % REPO_COLORS.length];
}

const FIELD_FILTERS: Record<string, (i: Issue, v: string) => boolean> = {
  title: (i, v) => i.title.toLowerCase().includes(v),
  repo: (i, v) => i.repo.toLowerCase().includes(v),
  owner: (i, v) => i.owner.toLowerCase().includes(v),
  state: (i, v) => i.state.toLowerCase().includes(v),
  body: (i, v) => (i.body ?? '').toLowerCase().includes(v),
  number: (i, v) => String(i.number).includes(v),
};

export function matchesIssue(issue: Issue, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const global: string[] = [];
  for (const token of tokens) {
    const m = token.match(/^([a-z]+):(.*)$/);
    if (m && FIELD_FILTERS[m[1]]) {
      if (!FIELD_FILTERS[m[1]](issue, m[2])) return false;
    } else {
      global.push(token);
    }
  }
  if (global.length === 0) return true;
  const haystack = [issue.owner, issue.repo, `#${issue.number}`, issue.title, issue.body ?? '']
    .join(' ')
    .toLowerCase();
  return global.every((term) => haystack.includes(term));
}

export function relTime(iso: string): string {
  // SQLite stores timestamps as 'YYYY-MM-DD HH:MM:SS' (treated as UTC).
  // SSE events stamp with toISOString() producing '...T...Z' or '+HH:MM'.
  // Normalise both to a parseable Date.
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [secsInUnit, label] of units) {
    if (secs >= secsInUnit) return `${Math.floor(secs / secsInUnit)}${label} ago`;
  }
  return `${secs}s ago`;
}

export function excerpt(body: string): string {
  const flat = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

export function countRepos(issues: Pick<Issue, 'owner' | 'repo'>[]): number {
  return new Set(issues.map((i) => `${i.owner}/${i.repo}`)).size;
}

// Human-friendly label for GitHub's `state_reason` on a reconciled card.
export function closedReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'not_planned':
      return 'not planned';
    case 'reopened':
      return 'reopened';
    default:
      return 'closed';
  }
}

export type CardActionId =
  | 'work'
  | 'to-refinement'
  | 'to-backlog'
  | 'recap'
  | 'select-batch'
  | 'open-github';

export interface CardAction {
  id: CardActionId;
  label: string;
}

// A card is workable in backlog/refinement, or in developing after a failed
// run (blocked_reason set) — never while a develop session is still live.
export function isWorkable(issue: Pick<Issue, 'state' | 'blockedReason'>): boolean {
  return (
    issue.state === 'backlog' ||
    issue.state === 'refinement' ||
    (issue.state === 'developing' && Boolean(issue.blockedReason))
  );
}

// Drives the mobile card-actions sheet. Mirrors the conditionals already on
// desktop's Card component (Refine/Back-to-backlog, Work, always-present
// Recap) — see CardActionsSheet. `live` covers a run started from this client
// that no server broadcast has confirmed yet: the Work button and manual
// stage moves must go away the moment work starts.
export function cardActions(
  issue: Pick<Issue, 'state' | 'blockedReason'>,
  live = false
): CardAction[] {
  const actions: CardAction[] = [];
  if (!live && isWorkable(issue)) {
    actions.push({ id: 'work', label: 'Work' });
  }
  if (!live && issue.state === 'backlog') {
    actions.push({ id: 'to-refinement', label: 'Move to refinement' });
  }
  if (!live && issue.state === 'refinement') {
    actions.push({ id: 'to-backlog', label: 'Move to backlog' });
  }
  actions.push({
    id: 'recap',
    label: live || (issue.state === 'developing' && !issue.blockedReason) ? 'Recap (live)' : 'Recap',
  });
  actions.push({ id: 'select-batch', label: 'Select for batch' });
  actions.push({ id: 'open-github', label: 'Open on GitHub' });
  return actions;
}

// The four active kanban columns (rollout/closed render as strips).
export const KANBAN_COLUMNS: IssueState[] = ['backlog', 'refinement', 'developing', 'pr'];

// A "just started" flag outlives the initial click: the develop route returns
// 202 before startWork broadcasts anything, and a backlog card's first
// broadcast (backlog → refinement) still leaves the run live. The flag is
// dropped only when a broadcast shows the server has taken over with its own
// live signal or the run has stopped:
//   developing            → run confirmed live (or failed — blocked drives UI)
//   pr/rollout/closed     → run finished
//   blocked_reason set    → run stopped, "Needs input" + Work must return
// A bare refinement/backlog broadcast (the initial stage move, session-id
// updates) leaves the flag in place — the run is still going.
export function runSupersededByBroadcast(issue: Pick<Issue, 'state' | 'blockedReason'>): boolean {
  if (issue.state === 'developing' || issue.state === 'pr' || issue.state === 'rollout' || issue.state === 'closed') {
    return true;
  }
  return Boolean(issue.blockedReason);
}

// Fire a browser notification when a card lands in a state that needs the
// operator's attention (PR opened = success, blocked_reason = needs input).
// Only fires for changes seen live over SSE; existing cards on load are not
// re-notified.
export function notifyStateChange(issue: Issue): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const blocked = Boolean(issue.blockedReason);
  const title = blocked
    ? 'DevHub: needs input'
    : issue.state === 'pr'
      ? 'DevHub: pull request opened'
      : `DevHub: ${issue.state}`;
  const body = `${issue.owner}/${issue.repo} #${issue.number}: ${issue.title}`;
  try {
    new Notification(title, { body, tag: `devhub-${issue.id}-${blocked ? 'blocked' : issue.state}` });
  } catch {
    // ignore
  }
}

// Staleness tier for a card, based on time since last update. Used as a
// lightweight urgency cue for triaging a crowded backlog.
export function urgencyTier(iso: string): 'fresh' | 'aging' | 'stale' {
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return 'fresh';
  const days = (Date.now() - then) / 86400000;
  if (days >= 14) return 'stale';
  if (days >= 4) return 'aging';
  return 'fresh';
}

export interface PrimaryCardAction {
  label: string;
  kind: 'work' | 'recap';
}

export function primaryCardAction(
  issue: Pick<Issue, 'state' | 'blockedReason'>,
  live = false
): PrimaryCardAction {
  if (!live && isWorkable(issue)) return { label: 'Work', kind: 'work' };
  if (live || (issue.state === 'developing' && !issue.blockedReason)) {
    return { label: 'Recap (live)', kind: 'recap' };
  }
  return { label: 'Recap', kind: 'recap' };
}
