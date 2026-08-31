import { getDb } from './store';

// Long-term knowledge backed by SQLite FTS5 full-text search. Structured
// entries (domain + summary + details) are stored in a single FTS5 virtual
// table; `details`/`sourceActionId`/`createdAt` ride along as UNINDEXED
// columns so only the free-text fields participate in MATCH. Zero external
// dependencies — no LLM, no vector store, no embedder.

export interface MemoryEntry {
  id: number;
  memory: string;
  domain: string;
  details: string;
  sourceActionId: number | null;
  createdAt: string;
  score?: number;
}

const COLS =
  'rowid AS id, domain, summary AS memory, details, source_action_id AS sourceActionId, created_at AS createdAt';

let initialized = false;

function ensureTable(): void {
  if (initialized) return;
  getDb().exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      domain,
      summary,
      details,
      source_action_id UNINDEXED,
      created_at UNINDEXED
    );
  `);
  initialized = true;
}

function toEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as number,
    memory: row.memory as string,
    domain: row.domain as string,
    details: row.details as string,
    sourceActionId: row.sourceActionId as number | null,
    createdAt: row.createdAt as string,
    ...(typeof row.score === 'number' ? { score: row.score } : {}),
  };
}

// Best-effort capture. Never throws — knowledge is a side effect of a skill
// run and must not fail the run.
export function remember(
  domain: string,
  summary: string,
  details: Record<string, unknown>,
  sourceActionId?: number
): void {
  try {
    ensureTable();
    getDb()
      .prepare(
        `INSERT INTO knowledge_fts (domain, summary, details, source_action_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .run(domain, summary, JSON.stringify(details), sourceActionId ?? null);
  } catch (err) {
    console.error('[knowledge] remember failed:', err);
  }
}

// Split a free-text query into safe FTS5 term tokens (AND-joined), so
// punctuation and special characters in user input can never break MATCH.
function ftsQuery(query: string): string {
  const tokens = query.toLowerCase().match(/[\w][\w-]*/g) ?? [];
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

// Full-text recall, ranked by bm25 (lower score = better match). Never throws.
export function recall(query: string, domain?: string, limit = 5): MemoryEntry[] {
  try {
    ensureTable();
    const match = ftsQuery(query);
    if (!match) return [];
    let sql = `SELECT ${COLS}, bm25(knowledge_fts) AS score
      FROM knowledge_fts WHERE knowledge_fts MATCH ?`;
    const args: Array<string | number> = [match];
    if (domain) {
      sql += ' AND domain = ?';
      args.push(domain);
    }
    sql += ' ORDER BY score LIMIT ?';
    args.push(limit);
    const rows = getDb().prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(toEntry);
  } catch (err) {
    console.error('[knowledge] recall failed:', err);
    return [];
  }
}

// List stored knowledge, newest first. Never throws.
export function listKnowledge(domain?: string, limit = 100): MemoryEntry[] {
  try {
    ensureTable();
    let sql = `SELECT ${COLS} FROM knowledge_fts`;
    const args: Array<string | number> = [];
    if (domain) {
      sql += ' WHERE domain = ?';
      args.push(domain);
    }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
    args.push(limit);
    const rows = getDb().prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(toEntry);
  } catch (err) {
    console.error('[knowledge] list failed:', err);
    return [];
  }
}