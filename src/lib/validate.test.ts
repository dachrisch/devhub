import { describe, expect, it } from 'vitest';
import { buildRefinePrompt, extractCheckboxes, parseRefineResult, sanitizeAcceptanceCriteria } from './validate.js';

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
    expect(result).toEqual({ ready: true, summary: 'Clear scope', improvedBody: null, blockingQuestions: [], scope: 'service', infraFirst: false, acceptanceCriteria: [] });
  });

  it('parses scope and run order for multi-repo work', () => {
    const result = parseRefineResult(
      '{"ready": true, "summary": "spans both", "improvedBody": null, "blockingQuestions": [], "scope": "both", "infra_first": true}'
    );
    expect(result.scope).toBe('both');
    expect(result.infraFirst).toBe(true);
  });

  it('falls back to service scope for unknown scope values', () => {
    const result = parseRefineResult(
      '{"ready": true, "summary": "x", "improvedBody": null, "blockingQuestions": [], "scope": "nope", "infra_first": true}'
    );
    expect(result.scope).toBe('service');
    expect(result.infraFirst).toBe(false);
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

  it('parses refiner-supplied acceptance criteria', () => {
    const result = parseRefineResult(
      '{"ready": true, "summary": "ok", "improvedBody": null, "blockingQuestions": [], "acceptanceCriteria": ["pill renders", "  ", "build green"]}'
    );
    expect(result.acceptanceCriteria).toEqual(['pill renders', 'build green']);
  });

  it('falls back to checkboxes in the improved body when the array is missing', () => {
    const result = parseRefineResult(
      '{"ready": true, "summary": "ok", "improvedBody": "# T\\n\\n- [ ] first thing\\n- [x] done thing\\n- plain bullet", "blockingQuestions": []}'
    );
    expect(result.acceptanceCriteria).toEqual(['first thing', 'done thing']);
  });

  it('caps and truncates runaway criteria lists', () => {
    const many = Array.from({ length: 30 }, (_, i) => `criterion ${i} ${'x'.repeat(400)}`);
    const result = sanitizeAcceptanceCriteria(many);
    expect(result).toHaveLength(20);
    expect(result[0].length).toBe(300);
    expect(sanitizeAcceptanceCriteria('not-an-array')).toEqual([]);
    expect(sanitizeAcceptanceCriteria([null, 42, ''])).toEqual(['42']);
  });

  it('extracts checkbox items from markdown bodies', () => {
    expect(extractCheckboxes('- [ ] a\n* [X] b\n- [x] c\n- no box')).toEqual(['a', 'b', 'c']);
    expect(extractCheckboxes(null)).toEqual([]);
  });

  it('asks the refiner for testable acceptance criteria', () => {
    expect(buildRefinePrompt(issue())).toContain('acceptanceCriteria');
  });
});
