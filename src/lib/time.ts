// SQLite `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in UTC with no zone
// designator. `new Date()` parses that as LOCAL time, so a UTC+2 viewer sees a
// just-created event as "2h ago". Normalize to ISO-8601 UTC before parsing.

const HAS_ZONE = /[zZ]$|[+-]\d\d:?\d\d$/;

export function parseSqliteUtc(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const normalized = HAS_ZONE.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

export function relativeTime(ts: string): string {
  const t = parseSqliteUtc(ts);
  if (!Number.isFinite(t)) return '';
  const abs = Math.abs(Date.now() - t);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
