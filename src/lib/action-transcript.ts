import type { OpencodeEvent } from './opencode';
import { eventSnippet, isNoise } from './recap';

// Rolling transcript of what a cockpit action printed while it ran.
//
// Opencode streams `message.part.updated` events; a text part's update carries
// the (usually cumulative) part text, so updates for the *same* part id must
// replace their previous line rather than append — otherwise streaming output
// floods the transcript with ever-growing duplicates. Events with no
// recognizable text content and recap-noise events (tool calls, reasoning,
// keepalives) produce no line at all.
//
// The recorder is transport-agnostic: `onTick` publishes the newest line for
// live SSE tailing, `onFlush` persists the joined transcript (both throttled).
// The buffer trims from the front once `maxLines`/`maxChars` are exceeded, so
// a chatty run cannot grow without bound.

export interface TranscriptRecorderOptions {
  onFlush?: (text: string) => void;
  onTick?: (latestLine: string) => void;
  flushIntervalMs?: number;
  tickIntervalMs?: number;
  maxLines?: number;
  maxChars?: number;
}

export interface TranscriptRecorder {
  add: (event: OpencodeEvent) => void;
  // Clears any pending flush timer and persists the current transcript.
  // Returns the joined transcript.
  final: () => string;
}

const FLUSH_INTERVAL_MS = 1000;
const TICK_INTERVAL_MS = 1000;
const MAX_LINES = 200;
const MAX_CHARS = 32768;

// Unwraps the part regardless of which opencode shape is in play (mirrors
// recap.payload): code.lehel.xyz sends `data`, the SDK v2 sends `properties`.
function partOf(ev: unknown): Record<string, unknown> {
  if (!ev || typeof ev !== 'object') return {};
  const e = ev as { data?: unknown; properties?: unknown };
  const raw = e.properties ?? e.data ?? ev;
  if (!raw || typeof raw !== 'object') return {};
  const p = raw as { part?: unknown };
  if (p.part && typeof p.part === 'object') return p.part as Record<string, unknown>;
  return raw as Record<string, unknown>;
}

function partKey(part: Record<string, unknown>): string | null {
  const id = part.id ?? part.callID;
  return typeof id === 'string' && id ? id : null;
}

export function createTranscriptRecorder(options: TranscriptRecorderOptions = {}): TranscriptRecorder {
  const {
    onFlush,
    onTick,
    flushIntervalMs = FLUSH_INTERVAL_MS,
    tickIntervalMs = TICK_INTERVAL_MS,
    maxLines = MAX_LINES,
    maxChars = MAX_CHARS,
  } = options;

  const lines: string[] = [];
  // part id → index into `lines`, so a part's cumulative updates replace
  // their line in place.
  const indexByPart = new Map<string, number>();
  let dirty = false;
  let lastTickAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const join = (): string => lines.join('\n');

  function reindexAfterDrop(dropped: number): void {
    if (dropped <= 0) return;
    for (const [key, idx] of Array.from(indexByPart)) {
      if (idx < dropped) indexByPart.delete(key);
      else indexByPart.set(key, idx - dropped);
    }
  }

  function trim(): void {
    const before = lines.length;
    let dropped = 0;
    while (lines.length > maxLines) {
      lines.shift();
      dropped++;
    }
    // Char cap trims whole lines from the front (log-like: oldest first), but
    // always keeps the newest line.
    while (lines.length > 1 && join().length > maxChars) {
      lines.shift();
      dropped++;
    }
    if (dropped > 0) reindexAfterDrop(dropped);
  }

  function flush(): void {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      onFlush?.(join());
    } catch {
      /* persistence is best-effort */
    }
  }

  function maybeTick(line: string): void {
    if (!onTick) return;
    const now = Date.now();
    if (now - lastTickAt >= tickIntervalMs) {
      lastTickAt = now;
      try {
        onTick(line);
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, flushIntervalMs);
  }

  return {
    add(event) {
      if (isNoise(event)) return;
      const part = partOf(event);
      const key = partKey(part);
      const snippet = eventSnippet(event);
      if (!snippet) return;

      const existing = key !== null ? indexByPart.get(key) : undefined;
      if (existing !== undefined && lines[existing] !== undefined) {
        lines[existing] = snippet;
        // Replace-in-place is not a "new" line; tick so the live tail still
        // surfaces the changed content, but the strip's newest-line semantics
        // stay best-effort (mid-buffer replacements are rare).
        dirty = true;
        maybeTick(lines[existing]);
      } else {
        if (key !== null) indexByPart.set(key, lines.length);
        lines.push(snippet);
        dirty = true;
        maybeTick(snippet);
      }
      trim();
      if (dirty) scheduleFlush();
    },

    final() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (onFlush && (dirty || lines.length > 0)) {
        dirty = false;
        try {
          onFlush(join());
        } catch {
          /* ignore */
        }
      }
      return join();
    },
  };
}
