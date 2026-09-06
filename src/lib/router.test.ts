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

  it('parses fenced JSON (Action #3: model wraps reply in ```json)', () => {
    const fenced = '```json\n{ "action": "fix", "confidence": 0.85, "params": { "issueId": 7 } }\n```';
    const result = parseIntent(fenced);
    expect(result.action).toBe('fix');
    expect(result.confidence).toBe(0.85);
    expect(result.params.issueId).toBe(7);
  });

  it('extracts JSON from surrounding chatter', () => {
    const raw = 'Sure! Here you go:\n{ "action": "create", "confidence": 0.9, "params": { "repo": "devhub", "issueTitle": "styled recap" } }\nDone.';
    const result = parseIntent(raw);
    expect(result.action).toBe('create');
    expect(result.confidence).toBe(0.9);
    expect(result.params.repo).toBe('devhub');
  });

  it('parses create action', () => {
    const result = parseIntent(JSON.stringify({
      action: 'create',
      confidence: 0.88,
      params: { repo: 'devhub', issueTitle: 'styled recap' },
    }));
    expect(result.action).toBe('create');
    expect(result.params.repo).toBe('devhub');
  });
});
