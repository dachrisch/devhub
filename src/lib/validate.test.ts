import { describe, expect, it } from 'vitest';
import { buildRefinePrompt, parseRefineResult } from './validate.js';

function issue() {
  return {
    id: 1,
    githubIssueId: 123,
    owner: 'test',
    repo: 'repo',
    number: 1,
    title: 'Test Issue',
    body: 'Test body',
    htmlUrl: 'https://github.com/test/repo/issues/1',
    state: 'backlog' as const,
    sessionId: null,
    resultPrUrl: null,
    resultText: null,
    blockedReason: null,
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    stateReason: null,
    modelId: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

describe('buildRefinePrompt', () => {
  it('builds refinement prompt with issue details', () => {
    const prompt = buildRefinePrompt(issue());
    expect(prompt).toContain('Test Issue');
    expect(prompt).toContain('Test body');
    expect(prompt).toContain('test/repo');
    expect(prompt).toContain('You are refining');
  });

  it('handles a missing body', () => {
    const prompt = buildRefinePrompt({ ...issue(), body: null });
    expect(prompt).toContain('(no description)');
  });
});

describe('parseRefineResult', () => {
  it('parses a ready JSON response without improvements', () => {
    const result = parseRefineResult(
      '{"ready": true, "summary": "Clear scope", "improvedBody": null, "blockingQuestions": []}'
    );
    expect(result).toEqual({ ready: true, summary: 'Clear scope', improvedBody: null, blockingQuestions: [] });
  });

  it('parses a ready JSON response with an improved body', () => {
    const result = parseRefineResult(
      'Some preamble\n{"ready": true, "summary": "minor gaps", "improvedBody": "# Improved\\n\\nbody", "blockingQuestions": []}\ntrailer'
    );
    expect(result.ready).toBe(true);
    expect(result.improvedBody).toBe('# Improved\n\nbody');
    expect(result.blockingQuestions).toEqual([]);
  });

  it('parses a not-ready response with blocking questions', () => {
    const result = parseRefineResult(
      '{"ready": false, "summary": "ambiguous", "improvedBody": null, "blockingQuestions": ["SQL or NoSQL?", "Which auth flow?"]}'
    );
    expect(result.ready).toBe(false);
    expect(result.blockingQuestions).toEqual(['SQL or NoSQL?', 'Which auth flow?']);
  });

  it('coerces missing fields defensively', () => {
    const result = parseRefineResult('{"ready": "yes"}');
    expect(result.ready).toBe(true);
    expect(result.improvedBody).toBeNull();
    expect(result.blockingQuestions).toEqual([]);
  });

  it('falls back to the plain-text READY convention', () => {
    const result = parseRefineResult('READY: Clear scope and acceptance criteria');
    expect(result.ready).toBe(true);
    expect(result.summary).toBe('Clear scope and acceptance criteria');
  });

  it('treats unparseable text as not ready (conservative default)', () => {
    const result = parseRefineResult('The issue looks good overall');
    expect(result.ready).toBe(false);
    expect(result.summary).toBe('The issue looks good overall');
  });

  it('survives malformed JSON', () => {
    const result = parseRefineResult('{ready: true, oops');
    expect(result.ready).toBe(false);
  });
});
