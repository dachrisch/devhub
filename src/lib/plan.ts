import type { Issue } from './types';

export interface BriefItem {
  number: number;
  title: string;
  gist: string;
}

export interface RepoBrief {
  repo: string;
  items: BriefItem[];
}

const RECENT_CLOSED_MS = 30 * 86400000;
const GIST_MAX = 200;

// Context brief: open + recently closed (~30d) issues condensed per repo to
// title/number/one-para gist — never raw bodies (prompt-budget discipline).
export function buildContextBrief(issues: Issue[], nowMs: number = Date.now()): RepoBrief[] {
  const byRepo = new Map<string, BriefItem[]>();
  for (const i of issues) {
    if (i.state === 'closed') {
      const updated = Date.parse(i.updatedAt);
      if (!Number.isFinite(updated) || nowMs - updated > RECENT_CLOSED_MS) continue;
    } else if (i.state === 'rollout') {
      continue;
    }
    const gist = gistOf(i.body);
    const repo = `${i.owner}/${i.repo}`;
    const list = byRepo.get(repo) ?? [];
    list.push({ number: i.number, title: i.title, gist });
    byRepo.set(repo, list);
  }
  return [...byRepo.entries()].map(([repo, items]) => ({ repo, items }));
}

function gistOf(body: string | null): string {
  if (!body) return '';
  const firstPara = body.split(/\n\s*\n/)[0] ?? '';
  const flat = firstPara.replace(/\s+/g, ' ').trim();
  return flat.length > GIST_MAX ? `${flat.slice(0, GIST_MAX - 1)}…` : flat;
}

export interface SplitItem {
  repo: string;
  title: string;
  body: string;
  why: string;
}

function isSplitItem(o: unknown): o is SplitItem {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return typeof r.repo === 'string' && typeof r.title === 'string';
}

// Split proposals arrive on the last thread_event as {repo, title, body,
// why} records — nothing is auto-created. Accepts a fenced JSON array;
// anything else (prose, headers) yields [] and the thread stays planning.
export function parseSplitProposal(text: string): SplitItem[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!fence) return [];
  try {
    const parsed: unknown = JSON.parse(fence[1].trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSplitItem).map((o) => ({
      repo: o.repo,
      title: o.title,
      body: typeof o.body === 'string' ? o.body : '',
      why: typeof o.why === 'string' ? o.why : '',
    }));
  } catch {
    return [];
  }
}

export interface CappedSplit {
  kept: SplitItem[];
  capped: boolean;
  offered: number;
}

// Confirm cap: ≤10 cards per proposal, by design not by accident. The planner
// is instructed to cap and offer; this enforces it server-side too.
export function capSplitProposal(items: SplitItem[], cap = 10): CappedSplit {
  return {
    kept: items.slice(0, cap),
    capped: items.length > cap,
    offered: items.length,
  };
}

export function buildPlannerPrompt(brief: RepoBrief[], userText: string, wholeBoard = false): string {
  const lines: string[] = [
    'You are a DevHub implementation strategist. Context brief (open + recently closed issues, condensed):',
    '',
  ];
  for (const repo of brief) {
    lines.push(`## ${repo.repo}`);
    for (const item of repo.items) {
      lines.push(`- #${item.number} ${item.title}: ${item.gist}`);
    }
  }
  lines.push(
    '',
    `User request: ${userText}`,
    '',
    wholeBoard
      ? 'Scope: the whole board — there is no repo filter. Consider every repo above as one workstream.'
      : 'Scope: the repos listed above.',
    'Each turn ends in one of: strategy content, follow-up questions, or a split proposal.',
    'A split proposal is a fenced json array of {repo, title, body, why} records.',
    'Propose at most 10 cards per split (cap and offer the rest as a follow-up).',
    'Nothing is created until the operator confirms — ask, do not act.'
  );
  return lines.join('\n');
}
