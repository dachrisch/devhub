import { getAction, getActions } from './store';
import { recall, remember } from './knowledge';

// Self-learning loop for the cockpit router. All persistence rides on the
// existing substrates — no new tables, no embeddings:
//
// - `actions` rows are the training data (input + classified intent + status)
// - `knowledge_fts` is the memory (corrections + unknown patterns, FTS5 recall)
//
// Flow:
//   1. `getRouterLearnings(input)` is injected into the router prompt, so past
//      corrections bias the next classification.
//   2. `learnUnknown(...)` records low-confidence inputs for clustering.
//   3. `learnCorrection(...)` records retryOf success pairs (teach-by-rerun).
//   4. `clusterUnknowns()` groups repeated unknowns into skill proposals.

export const ROUTER_CORRECTION_DOMAIN = 'router-correction';
export const ROUTER_UNKNOWN_DOMAIN = 'router-unknown';

export interface UnknownCluster {
  key: string;
  count: number;
  examples: { id: number; input: string }[];
  suggestedSkill: string;
}

function normalizeKey(input: string, params: Record<string, unknown>): string {
  const task = typeof params.task === 'string' ? params.task.trim().toLowerCase() : '';
  if (task) return task.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const tokens = input.toLowerCase().match(/[\w][\w-]*/g) ?? [];
  return tokens.slice(0, 4).join('_').slice(0, 60) || 'unknown';
}

function toSuggestedSkill(key: string): string {
  const name = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom';
  return name;
}

// Best-effort: recall is sync FTS, never throws (knowledge.ts guards).
// FTS MATCH is AND-joined, so a long cockpit prompt rarely matches verbatim —
// fall back from the full query to the most distinctive tokens.
export function getRouterLearnings(input: string, limit = 3): string {
  try {
    let corrections = recall(input, ROUTER_CORRECTION_DOMAIN, limit);
    if (corrections.length === 0) {
      const tokens = (input.toLowerCase().match(/[\w][\w-]*/g) ?? []).filter((t) => t.length > 3);
      const distinctive = [...tokens].sort((a, b) => b.length - a.length).slice(0, 2);
      for (const token of distinctive) {
        corrections = recall(token, ROUTER_CORRECTION_DOMAIN, limit);
        if (corrections.length > 0) break;
      }
    }
    if (corrections.length === 0) return '';
    const lines = corrections.map((c) => {
      let detail = '';
      try {
        const d = JSON.parse(c.details) as { originalInput?: string; correctedInput?: string; action?: string };
        detail = `"${d.originalInput ?? ''}" -> "${d.correctedInput ?? ''}" (${d.action ?? 'unknown'})`;
      } catch {
        detail = c.memory;
      }
      return `- ${detail}`;
    });
    return `Past corrections for similar requests:\n${lines.join('\n')}\nPrefer the corrected classification when the request matches.`;
  } catch {
    return '';
  }
}

export function learnUnknown(actionId: number, input: string, params: Record<string, unknown>): void {
  remember(
    ROUTER_UNKNOWN_DOMAIN,
    `Unknown request: "${input.slice(0, 200)}" (task=${String(params.task ?? '?')})`,
    { input: input.slice(0, 500), params },
    actionId
  );
}

export function learnCorrection(
  actionId: number,
  retryOfId: number,
  correctedInput: string,
  action: string,
  params: Record<string, unknown>
): void {
  const original = getAction(retryOfId);
  if (!original) return;
  remember(
    ROUTER_CORRECTION_DOMAIN,
    `Correction: "${original.input.slice(0, 120)}" -> "${correctedInput.slice(0, 120)}" (${action})`,
    {
      originalInput: original.input.slice(0, 500),
      correctedInput: correctedInput.slice(0, 500),
      action,
      params,
      retryOf: retryOfId,
    },
    actionId
  );
}

// Groups recent failed/unknown actions by normalized task key. Reads the live
// `actions` table (no new storage); callers decide the proposal threshold.
export function clusterUnknowns(limit = 100): UnknownCluster[] {
  const rows = getActions(limit);
  const groups = new Map<string, { id: number; input: string }[]>();
  for (const row of rows) {
    if (row.status !== 'failed') continue;
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params) as Record<string, unknown>;
    } catch {
      params = {};
    }
    // Only cluster router failures: unknown intent or missing skill.
    const result = row.result ?? '';
    const isRouterFailure =
      row.action === 'unknown' ||
      row.action === 'pending' ||
      result.includes('Could you rephrase') ||
      result.includes("isn't built yet");
    if (!isRouterFailure) continue;
    const key = normalizeKey(row.input, params);
    const list = groups.get(key) ?? [];
    list.push({ id: row.id, input: row.input });
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, examples]) => ({
      key,
      count: examples.length,
      examples: examples.slice(0, 3),
      suggestedSkill: toSuggestedSkill(key),
    }))
    .sort((a, b) => b.count - a.count);
}
