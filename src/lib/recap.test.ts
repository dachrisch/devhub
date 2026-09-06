import { describe, expect, it } from 'vitest';
import { activityLine, condense, eventSnippet, eventText, isNoise, truncateText } from './recap';
import type { IssueEvent } from './types';

function ev(payload: unknown, kind = 'opencode'): IssueEvent {
  return { id: 0, issueId: 1, kind, payload, ts: 't' };
}

describe('recap helpers', () => {
  it('flags tool calls, reasoning, and keepalives as noise', () => {
    expect(isNoise({ type: 'tool.called', data: { tool: 'bash' } })).toBe(true);
    expect(isNoise({ type: 'tool.success', data: { tool: 'bash' } })).toBe(true);
    expect(isNoise({ type: 'message.part.updated', properties: { part: { type: 'tool' } } })).toBe(true);
    expect(isNoise({ type: 'message.part.updated', properties: { part: { type: 'reasoning' } } })).toBe(true);
    expect(isNoise({ type: 'server.heartbeat' })).toBe(true);
    expect(isNoise({ type: 'server.connected' })).toBe(true);
  });

  it('keeps meaningful text and step events', () => {
    expect(isNoise({ type: 'message.part.updated', properties: { part: { type: 'text', text: 'done' } } })).toBe(false);
    expect(isNoise({ type: 'message.part.updated', properties: { part: { type: 'step-start' } } })).toBe(false);
    expect(isNoise({ type: 'text', data: { text: 'hi' } })).toBe(false);
    expect(isNoise(undefined)).toBe(false);
  });

  it('renders a short activity line', () => {
    expect(activityLine({ type: 'message.part.updated', properties: { part: { type: 'text' } } })).toBe('Writing response…');
    expect(activityLine({ type: 'message.part.updated', properties: { part: { type: 'step-start' } } })).toBe(
      'Working on a step…'
    );
    expect(activityLine({ type: 'session.updated' })).toBe('In session…');
    expect(activityLine({ type: 'message.part.updated', properties: { part: { type: 'tool' } } })).toBe('Working…');
    expect(activityLine(undefined)).toBe('Working…');
  });

  it('extracts a snippet from text and title', () => {
    expect(eventSnippet({ type: 'text', data: { text: '  hello   world ' } })).toBe('hello world');
    expect(eventSnippet({ type: 'step', data: { title: 'Set up worktree' } })).toBe('Set up worktree');
    expect(eventSnippet({ type: 'message.part.updated', properties: { part: { type: 'text', text: 'nested' } } })).toBe(
      'nested'
    );
    expect(eventSnippet({ type: 'x' })).toBe('');
  });

  it('extracts markdown-preserving text with newlines intact', () => {
    const md = '## Summary\n\n- one\n- two\n\n```ts\nconst x = 1;\n```';
    expect(eventText({ type: 'text', data: { text: md } })).toBe(md);
    expect(eventText({ type: 'message.part.updated', properties: { part: { type: 'text', text: md } } })).toBe(md);
    expect(eventText({ type: 'step', data: { title: 'Set up worktree' } })).toBe('Set up worktree');
    expect(eventText({ type: 'x' })).toBe('');
    // CRLF normalized, trailing spaces stripped, 3+ blank lines collapsed.
    expect(eventText({ type: 'text', data: { text: 'a  \r\n\r\n\r\nb   ' } })).toBe('a\n\nb');
  });

  it('truncates long text safely with an ellipsis marker', () => {
    expect(truncateText('short', 2000)).toBe('short');
    expect(truncateText('a'.repeat(2000), 2000)).toBe('a'.repeat(2000));
    const out = truncateText('a'.repeat(2005), 2000);
    expect(out.length).toBeLessThan(2005);
    expect(out.endsWith('…')).toBe(true);
  });

  it('condenses consecutive identical opencode events but keeps non-opencode', () => {
    const events = [
      ev({ type: 'text', data: { text: 'a' } }),
      ev({ type: 'text', data: { text: 'a' } }),
      ev({ type: 'text', data: { text: 'b' } }),
      ev({ type: 'message', payload: { k: 1 } }, 'error'),
      ev({ type: 'text', data: { text: 'b' } }),
    ];
    const out = condense(events);
    expect(out).toHaveLength(4);
    expect(out.map((e) => eventSnippet(e.payload))).toEqual(['a', 'b', '', 'b']);
  });
});