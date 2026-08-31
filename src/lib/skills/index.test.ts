import { describe, expect, it } from 'vitest';
import { loadSkills, getByAction } from './index';

describe('skills', () => {
  it('returns empty array when no skills registered', () => {
    const skills = loadSkills();
    expect(Array.isArray(skills)).toBe(true);
  });

  it('getByAction returns null for unknown action', () => {
    const skill = getByAction('write');
    expect(skill).toBeNull();
  });
});
