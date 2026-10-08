export type CommandIntent = 'implement' | 'strategy' | 'question';

export interface ResolveChip {
  kind: 'repo-choice' | 'issue-search';
  label: string;
  options: string[];
}

export interface ResolveResult {
  intent: CommandIntent;
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

// Normalized for shorthand compare: lowercase, alphanumerics only.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lastSegment(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

// A repo mention candidate is either Capitalized (shorthand like XY, ZZZ) or
// a word that loosely matches a known repo name (e.g. `warehouse`, `app`).
function isCandidate(word: string, repoList: string[]): boolean {
  if (word.length < 2) return false;
  if (/[A-Z]/.test(word)) return true;
  if (word.length < 3) return false;
  const w = norm(word);
  return repoList.some((r) => norm(lastSegment(r)).includes(w) || w.includes(norm(lastSegment(r))));
}

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
  matched: string[];
  chips: ResolveChip[];
}

export function mapRepos(text: string, repoList: string[]): RepoMapping {
  const matched: string[] = [];
  const chips: ResolveChip[] = [];
  const claimed = new Set<string>();

  // Full owner/repo paths first — precise, never ambiguous.
  for (const m of text.matchAll(FULL_REPO_RE)) {
    const found = repoList.find((r) => r.toLowerCase() === m[1].toLowerCase());
    if (found && !claimed.has(found)) {
      claimed.add(found);
      matched.push(found);
    }
  }

  const words = text.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
  const unmatched: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (index === 0 && INTENT_VERBS.has(word.toLowerCase())) continue;
    if (!isCandidate(word, repoList)) continue;
    // Skip words already consumed by a full-path match.
    if (text.toLowerCase().includes(word.toLowerCase()) && matched.some((m) => norm(m).includes(norm(word)))) {
      continue;
    }
    const hits = repoList.filter((r) => !claimed.has(r) && repoMatches(word, r));
    if (hits.length === 1) {
      claimed.add(hits[0]);
      matched.push(hits[0]);
    } else if (hits.length > 1) {
      chips.push({ kind: 'repo-choice', label: `Which repo did you mean by "${word}"?`, options: hits });
    } else if (!matched.some((m) => norm(m).includes(norm(word)))) {
      unmatched.push(word);
    }
  }

  // Never silently guess: unrecognized mentions become keyword chips offering
  // the full repo list. An explicit #issue ref is precise enough to skip this.
  if (unmatched.length > 0 && extractIssueNumbers(text).length === 0) {
    chips.push({
      kind: 'repo-choice',
      label: `Unknown repo "${unmatched[0]}" — pick one:`,
      options: repoList,
    });
  }
  return { matched, chips };
}

export function parseIntent(text: string, hasOpenThread: boolean): CommandIntent {
  if (STRATEGY_RE.test(text)) return 'strategy';
  if (hasOpenThread && extractIssueNumbers(text).length === 0 && !mentionsRepo(text)) return 'question';
  return 'implement';
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
    return { intent, targets: [], chips: [], issueNumbers, openThreadId: opts.openThreadId };
  }
  if (intent === 'question') {
    return {
      intent,
      targets: [],
      chips: [{ kind: 'issue-search', label: 'Which work item is this about?', options: [] }],
      issueNumbers,
    };
  }
  return { intent, targets: mapping.matched, chips: mapping.chips, issueNumbers };
}

export function formatMention(owner: string, repo: string, number?: number): string {
  return number != null ? `${owner}/${repo}#${number}` : `${owner}/${repo}`;
}
