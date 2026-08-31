import { describe, expect, it } from 'vitest';
import { parseIntent } from './router';

describe('router', () => {
  it('parses launch action', () => {
    const result = parseIntent(JSON.stringify({
      action: 'launch',
      confidence: 0.95,
      params: { name: 'blog-api', framework: 'fastapi' },
    }));
    expect(result.action).toBe('launch');
    expect(result.confidence).toBe(0.95);
    expect(result.params.name).toBe('blog-api');
  });

  it('parses fix action', () => {
    const result = parseIntent(JSON.stringify({
      action: 'fix',
      confidence: 0.92,
      params: { issueId: 42 },
    }));
    expect(result.action).toBe('fix');
    expect(result.params.issueId).toBe(42);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseIntent('not json at all');
    expect(result.action).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('handles missing fields gracefully', () => {
    const result = parseIntent('{}');
    expect(result.action).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});
