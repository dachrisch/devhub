import type { IssueEvent } from './types';

type RecapPayload = Record<string, unknown>;

// Unwrap the event payload regardless of which opencode shape is in play:
// code.lehel.xyz sends `data`, the opencode SDK v2 sends `properties` with a
// nested `part`. Fall back to the event object itself.
function payload(ev: unknown): RecapPayload {
  if (!ev || typeof ev !== 'object') return {};
  const e = ev as { data?: unknown; properties?: unknown };
  const raw = e.properties ?? e.data ?? ev;
  if (!raw || typeof raw !== 'object') return {};
  return raw as RecapPayload;
}

function eventType(ev: unknown): string {
  if (!ev || typeof ev !== 'object') return '';
  const e = ev as { type?: unknown; kind?: unknown };
  return String(e.type ?? e.kind ?? '');
}

// Strip events that tell the operator nothing useful: tool calls,
// chain-of-thought reasoning, keepalives and the connection handshake.
export function isNoise(ev: unknown): boolean {
  const type = eventType(ev);
  const p = payload(ev);
  const part = (p.part ?? {}) as RecapPayload;
  const partType = typeof part.type === 'string' ? part.type : '';
  const haystack = `${type}.${partType}`.toLowerCase();
  if (haystack.includes('tool')) return true;
  if (haystack.includes('reasoning')) return true;
  if (type.includes('heartbeat') || type.includes('server.connected')) return true;
  return false;
}

// Short human line for "what the agent is doing right now".
export function activityLine(ev: unknown): string {
  const type = eventType(ev);
  const p = payload(ev);
  const part = (p.part ?? {}) as RecapPayload;
  const partType = typeof part.type === 'string' ? part.type : '';
  const label = `${type}.${partType}`.toLowerCase();
  if (label.includes('error')) return 'Hit an error…';
  if (label.includes('tool') || label.includes('reasoning')) return 'Working…';
  if (label.includes('step')) return 'Working on a step…';
  if (label.includes('text') || label.includes('message')) return 'Writing response…';
  if (label.includes('session')) return 'In session…';
  if (label.includes('finish') || label.includes('idle')) return 'Finishing up…';
  return 'Working…';
}

// Extract the meaningful snippet from an event: text content, a step title,
// or a tool name as a last resort.
export function eventSnippet(ev: unknown): string {
  const p = payload(ev);
  const raw = (p.part as RecapPayload | undefined) ?? p;
  const text =
    typeof raw.text === 'string'
      ? raw.text
      : typeof raw.title === 'string'
        ? raw.title
        : typeof raw.tool === 'string'
          ? `tool: ${raw.tool}`
          : '';
  return text.replace(/\s+/g, ' ').trim();
}

// The recap should read like a digest: collapse consecutive opencode events
// that render identically so streaming text deltas and repeated tool states
// don't flood the feed.
export function condense(events: IssueEvent[]): IssueEvent[] {
  const out: IssueEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.kind === 'opencode' && last && last.kind === 'opencode') {
      if (
        activityLine(e.payload) === activityLine(last.payload) &&
        eventSnippet(e.payload) === eventSnippet(last.payload)
      ) {
        continue;
      }
    }
    out.push(e);
  }
  return out;
}