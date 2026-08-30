import { describe, expect, it } from 'vitest';
import { buildValidatePrompt, parseValidationResult } from './validate.js';

describe('validate', () => {
  it('builds validation prompt with issue details', () => {
    const issue = {
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
      linkedPrUrl: null,
      releaseTag: null,
      releasedAt: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    
    const prompt = buildValidatePrompt(issue);
    expect(prompt).toContain('Test Issue');
    expect(prompt).toContain('Test body');
    expect(prompt).toContain('test/repo');
  });

  it('parses READY response', () => {
    const result = parseValidationResult('READY: Clear scope and acceptance criteria');
    expect(result.ready).toBe(true);
    expect(result.summary).toBe('Clear scope and acceptance criteria');
  });

  it('parses NEEDS_WORK response', () => {
    const result = parseValidationResult('NEEDS_WORK: Missing acceptance criteria');
    expect(result.ready).toBe(false);
    expect(result.summary).toBe('Missing acceptance criteria');
  });

  it('handles ambiguous responses', () => {
    const result = parseValidationResult('The issue looks good overall');
    expect(result.ready).toBe(false); // Conservative default
  });
});