import { describe, expect, it } from 'vitest';
import { parseSqliteUtc, relativeTime } from './time';

describe('parseSqliteUtc', () => {
  it('reads a zoneless SQLite datetime as UTC, not local', () => {
    expect(parseSqliteUtc('2026-10-08 22:00:00')).toBe(Date.UTC(2026, 9, 8, 22, 0, 0));
  });

  it('parses an ISO string with an explicit T separator the same way', () => {
    expect(parseSqliteUtc('2026-10-08T22:00:00')).toBe(Date.UTC(2026, 9, 8, 22, 0, 0));
  });

  it('leaves already-zoned timestamps alone', () => {
    expect(parseSqliteUtc('2026-10-08T22:00:00Z')).toBe(Date.UTC(2026, 9, 8, 22, 0, 0));
    expect(parseSqliteUtc('2026-10-08T22:00:00+02:00')).toBe(Date.UTC(2026, 9, 8, 20, 0, 0));
  });

  it('returns NaN for missing or invalid input', () => {
    expect(parseSqliteUtc(null)).toBeNaN();
    expect(parseSqliteUtc('')).toBeNaN();
  });
});

describe('relativeTime', () => {
  it('reports a freshly written SQLite timestamp as "just now"', () => {
    // What datetime('now') would write right now: UTC, zoneless, to the second.
    const now = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
    expect(relativeTime(now)).toBe('just now');
  });

  it('formats minutes, hours and days', () => {
    const at = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
    expect(relativeTime(at(5 * 60_000))).toBe('5m ago');
    expect(relativeTime(at(3 * 3_600_000))).toBe('3h ago');
    expect(relativeTime(at(2 * 86_400_000))).toBe('2d ago');
  });

  it('ignores the sign of the offset (never shows a future event)', () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    expect(relativeTime(future)).toBe('30m ago');
  });
});
