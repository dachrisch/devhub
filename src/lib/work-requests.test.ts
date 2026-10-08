import { describe, expect, it } from 'vitest';
import { deriveWorkRequestTitle } from './work-requests';

describe('deriveWorkRequestTitle', () => {
  it('keeps a short single-line request as the title', () => {
    expect(deriveWorkRequestTitle('update dependencies in devhub project')).toBe(
      'update dependencies in devhub project'
    );
  });

  it('uses the first non-empty line and drops the rest', () => {
    expect(deriveWorkRequestTitle('\n  Add dark mode\n\nmore detail here')).toBe('Add dark mode');
  });

  it('collapses whitespace and strips markdown heading markers', () => {
    expect(deriveWorkRequestTitle('#   Refactor    the board')).toBe('Refactor the board');
  });

  it('caps the title length', () => {
    const long = 'x'.repeat(400);
    expect(deriveWorkRequestTitle(long).length).toBe(120);
  });

  it('falls back to a placeholder for an empty request', () => {
    expect(deriveWorkRequestTitle('   ')).toBe('New work request');
  });
});
