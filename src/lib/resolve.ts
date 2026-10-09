export type CommandIntent = 'implement' | 'strategy' | 'question';

// `board` = the whole synced board (all repos we already see in DevHub);
// `dangling` = the operator named a repo-shaped target we could not resolve.
export type CommandScope = 'issue' | 'repos' | 'board' | 'dangling';

export interface ResolveChip {
  kind: 'repo-choice' | 'issue-search';
  label: string;
  options: string[];
  // For `issue-search`: the resolved repo scope(s) the hand-select list must
  // be limited to (empty = no repo known, search across all repos).
  repos?: string[];
}

export interface ResolveResult {
  intent: CommandIntent;
  scope: CommandScope;
  targets: string[];
  chips: ResolveChip[];
  issueNumbers: number[];
  openThreadId?: number;
}

export interface ResolveOptions {
  openThread: boolean;
  openThreadId?: number;
}

const STRATEGY_RE = /strateg|combined|across|both repos|look at the recent|multiple|overall plan/i;
const ISSUE_RE = /#(\d+)\b/g;
const FULL_REPO_RE = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
// Leading command verbs are never repo mentions ("Implement login in XY").
const INTENT_VERBS = new Set(
  'implement work fix ship build add create update refactor look show make run do plan check review merge release test suggest shape realize promote'.split(' ')
);
// Repo prepositions: a lowercase word right after one of these is an explicit
// repo mention ("fix it in app"), eligible for an ambiguity/unknown chip.
const REPO_PREPS = new Set(['in', 'for', 'of', 'across', 'repo', 'on']);
// An ask that opens interrogatively or names board-wide work has no target —
// it runs against the whole board, never a forced repo pick.
const EXPLORATORY_START_RE =
  /^\s*(which|what|whats|what's|where|when|why|who|how|should|could|would|any|list|suggest|recommend|prioriti[sz]e|brainstorm|ideas?|find|show)\b/i;
const WHOLE_BOARD_RE =
  /\b(low[- ]?hanging|next steps?|roadmap|whole board|across (the )?(board|repos?|projects?)|overall plan)\b/i;

// Normalized for shorthand compare: lowercase, alphanumerics only.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lastSegment(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

// Loose fuzzy match: a short/partial token that names part of a repo. Only
// explicit or reasonably long lowercase words are allowed to reach here (see
// the length guard in mapRepos) so prose words like "low" cannot resolve.
function repoMatches(candidate: string, repo: string): boolean {
  const c = norm(candidate);
  if (!c) return false;
  const seg = norm(lastSegment(repo));
  const full = norm(repo);
  return seg.includes(c) || full.includes(c) || c.includes(seg);
}

export function extractIssueNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(ISSUE_RE)) out.push(Number(m[1]));
  return out;
}

export interface RepoMapping {
  // Every resolved target, including loose fuzzy matches ('warehouse').
  matched: string[];
  // Only targets named explicitly (full path, capitalized shorthand, or a word
  // after a repo preposition) — the signal that decides whole-board vs. a
  // concrete repo ask.
  explicit: string[];
  chips: ResolveChip[];
}

// A token is an explicit repo mention when it looks repo-shaped: a Capitalized
// shorthand (XY, ZZZ) or a word introduced by a repo preposition ("in app").
function looksLikeRepoIntent(word: string, index: number, words: string[]): boolean {
  if (/[A-Z]/.test(word)) return true;
  return REPO_PREPS.has(words[index - 1]?.toLowerCase() ?? '');
}

export function mapRepos(text: string, repoList: string[]): RepoMapping {
  const matched: string[] = [];
  const explicit: string[] = [];
  const chips: ResolveChip[] = [];
  const claimed = new Set<string>();

  // Full owner/repo paths first — precise, never ambiguous.
  for (const m of text.matchAll(FULL_REPO_RE)) {
    const found = repoList.find((r) => r.toLowerCase() === m[1].toLowerCase());
    if (found && !claimed.has(found)) {
      claimed.add(found);
      matched.push(found);
      explicit.push(found);
    }
  }

  const words = text.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (index === 0 && INTENT_VERBS.has(word.toLowerCase())) continue;
    // Skip words already consumed by a full-path match.
    if (matched.some((m) => norm(m).includes(norm(word)))) continue;
    const isExplicit = looksLikeRepoIntent(word, index, words);
    // Guard generic prose: only explicit mentions, or reasonably long lowercase
    // words, may fuzzy-match a repo ("low"/"next" must not resolve to anything).
    if (!isExplicit && word.length < 4) continue;
    const hits = repoList.filter((r) => !claimed.has(r) && repoMatches(word, r));
    if (hits.length === 1) {
      claimed.add(hits[0]);
      matched.push(hits[0]);
      if (isExplicit) explicit.push(hits[0]);
      continue;
    }
    // Only an explicit repo mention may produce a chip. Generic prose ("low",
    // "hanging") must never dump the board repo list.
    if (!isExplicit) continue;
    if (hits.length > 1) {
      // Ambiguous → choose-one chip, restricted to board repos.
      chips.push({ kind: 'repo-choice', label: `Which repo did you mean by "${word}"?`, options: hits });
    } else {
      // Unknown but explicit ("ZZZ") → pick-one chip, restricted to board repos.
      chips.push({ kind: 'repo-choice', label: `Unknown repo "${word}" — pick one:`, options: repoList });
    }
  }
  return { matched, explicit, chips };
}

export function parseIntent(text: string, hasOpenThread: boolean): CommandIntent {
  if (STRATEGY_RE.test(text)) return 'strategy';
  const hasTarget = extractIssueNumbers(text).length > 0 || mentionsRepo(text);
  // No target + an exploratory ask → whole-board strategy, not a repo pick.
  if (!hasTarget && isExploratory(text)) return 'strategy';
  if (hasOpenThread && !hasTarget) return 'question';
  return 'implement';
}

function isExploratory(text: string): boolean {
  return EXPLORATORY_START_RE.test(text) || WHOLE_BOARD_RE.test(text);
}

// Cheap repo-mention sniff for intent routing (the authoritative mapping lives
// in mapRepos, which needs the repo list).
function mentionsRepo(text: string): boolean {
  if (FULL_REPO_RE.test(text)) return true;
  FULL_REPO_RE.lastIndex = 0;
  return /\b(in|for|of|across|repo)\s+[A-Za-z][A-Za-z0-9_-]*/i.test(text);
}

export function resolveCommand(text: string, repoList: string[], opts: ResolveOptions): ResolveResult {
  const mapping = mapRepos(text, repoList);
  const issueNumbers = extractIssueNumbers(text);
  const hasRepoSignal = mapping.matched.length > 0 || issueNumbers.length > 0;
  let intent: CommandIntent = parseIntent(text, opts.openThread && !hasRepoSignal);
  // Recompute honestly: parseIntent's internal sniff must agree with mapping.
  if (intent === 'question' && hasRepoSignal) intent = 'implement';
  if (intent === 'question' && opts.openThreadId != null) {
    return { intent, scope: 'issue', targets: [], chips: [], issueNumbers, openThreadId: opts.openThreadId };
  }
  if (intent === 'question') {
    return {
      intent,
      scope: 'dangling',
      targets: [],
      chips: [{ kind: 'issue-search', label: 'Which work item is this about?', options: [], repos: [] }],
      issueNumbers,
    };
  }
  // Whole-board: an exploratory ask names no explicit repo/issue → run against
  // the board as a whole; never nag for a target.
  if (intent === 'strategy' && mapping.explicit.length === 0 && issueNumbers.length === 0) {
    return { intent, scope: 'board', targets: [], chips: [], issueNumbers };
  }
  const scope: CommandScope =
    mapping.explicit.length === 0 && mapping.chips.length > 0
      ? 'dangling'
      : issueNumbers.length > 0 && mapping.matched.length <= 1
        ? 'issue'
        : 'repos';
  return { intent, scope, targets: mapping.matched, chips: mapping.chips, issueNumbers };
}

export function formatMention(owner: string, repo: string, number?: number): string {
  return number != null ? `${owner}/${repo}#${number}` : `${owner}/${repo}`;
}
