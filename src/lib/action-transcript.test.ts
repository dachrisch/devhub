import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptRecorder } from './action-transcript.js';

// Mirrors the opencode SSE shapes: code.lehel.xyz unwraps to `data`, the SDK
// v2 nests a `part` object carrying the cumulative media text.
function textEvent(id: string, text: string, wrapper: 'properties' | 'data' = 'properties') {
  const part = { id, type: 'text', text };
  return wrapper === 'properties' ? { type: 'message.part.updated', properties: { part } } : { type: 'message.part.updated', data: part };
}

function toolEvent(id: string) {
  return { type: 'message.part.updated', properties: { part: { id, type: 'tool', tool: 'bash' } } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTranscriptRecorder', () => {
  it('records meaningful text lines and drops noise and empty events', () => {
    const recorder = createTranscriptRecorder();
    recorder.add(textEvent('p1', 'Hello world'));
    recorder.add(toolEvent('p2'));
    recorder.add({ type: 'message.updated', properties: { part: { type: 'text', text: '' } } });
    recorder.add({ type: 'heartbeat' });
    expect(recorder.final()).toBe('Hello world');
  });

  it('replaces the line in place when the same part id updates', () => {
    const recorder = createTranscriptRecorder();
    recorder.add(textEvent('p1', 'One'));
    recorder.add(textEvent('p1', 'One two'));
    recorder.add(textEvent('p1', 'One two three'));
    expect(recorder.final()).toBe('One two three');
  });

  it('separates distinct parts into distinct lines', () => {
    const recorder = createTranscriptRecorder();
    recorder.add(textEvent('p1', 'First'));
    recorder.add(textEvent('p2', 'Second'));
    expect(recorder.final()).toBe('First\nSecond');
  });

  it('accepts either opencode event wrapper shape', () => {
    const recorder = createTranscriptRecorder();
    recorder.add(textEvent('p1', 'via properties'));
    recorder.add(textEvent('p2', 'via data', 'data'));
    expect(recorder.final()).toBe('via properties\nvia data');
  });

  it('trims to maxLines from the front and keeps the newest content', () => {
    const recorder = createTranscriptRecorder({ maxLines: 3 });
    for (let i = 1; i <= 5; i++) recorder.add(textEvent(`p${i}`, `line-${i}`));
    expect(recorder.final()).toBe('line-3\nline-4\nline-5');
  });

  it('trims by total char budget across lines, always keeping the newest', () => {
    const recorder = createTranscriptRecorder({ maxLines: 100, maxChars: 50 });
    recorder.add(textEvent('p1', 'a'.repeat(20)));
    recorder.add(textEvent('p2', 'b'.repeat(20)));
    recorder.add(textEvent('p3', 'c'.repeat(20)));
    const text = recorder.final();
    expect(text).toBe(`${'b'.repeat(20)}\n${'c'.repeat(20)}`);
  });

  it('keeps a part id addressable after its line was trimmed', () => {
    const recorder = createTranscriptRecorder({ maxLines: 2 });
    recorder.add(textEvent('p1', 'old'));
    recorder.add(textEvent('p2', 'kept'));
    recorder.add(textEvent('p1', 'renewed'));
    // p1's line is replaced in place (first-appearance order), so "renewed"
    // stays at the front.
    expect(recorder.final()).toBe('renewed\nkept');
  });

  it('ticks live at most once per interval with the newest line', () => {
    const ticks: string[] = [];
    const recorder = createTranscriptRecorder({ onTick: (line) => ticks.push(line), tickIntervalMs: 1000 });
    recorder.add(textEvent('p1', 'one'));
    recorder.add(textEvent('p2', 'two')); // same instant → throttled away
    vi.advanceTimersByTime(1100);
    recorder.add(textEvent('p3', 'three'));
    expect(ticks).toEqual(['one', 'three']);
  });

  it('flushes on the interval and once at final', () => {
    const flushes: string[] = [];
    const recorder = createTranscriptRecorder({ onFlush: (text) => flushes.push(text), flushIntervalMs: 500 });
    recorder.add(textEvent('p1', 'early'));
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(flushes).toEqual(['early']);
    recorder.add(textEvent('p2', 'late'));
    recorder.final();
    expect(flushes).toEqual(['early', 'early\nlate']);
  });

  it('final clears a pending flush and persists the last state exactly once', () => {
    const flushes: string[] = [];
    const recorder = createTranscriptRecorder({ onFlush: (text) => flushes.push(text), flushIntervalMs: 500 });
    recorder.add(textEvent('p1', 'only'));
    recorder.final();
    expect(flushes).toEqual(['only']);
    vi.advanceTimersByTime(600);
    expect(flushes).toEqual(['only']);
  });
});
