/**
 * Every visit's timezone is client-supplied, never guessed server-side
 * (SPEC.md's T.4 deliverable) — the server has no way to know a user's
 * real local timezone at the moment of check-in. This file only validates
 * what the client sends; it never derives or overrides it.
 */

/** Real validity check via `Intl`, not a static IANA zone list to keep in sync. */
export function isValidIanaTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dateKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar date (`YYYY-MM-DD`) a UTC instant falls on **in the given
 * zone** — used to group check-ins by the day they actually happened in,
 * not the viewer's own day (`T.6`'s day-grouped timeline). Cached per zone
 * since this runs once per visit on every timeline render.
 */
export function localDateKey(utcMs: number, tzIana: string): string {
  let formatter = dateKeyFormatterCache.get(tzIana);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzIana,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateKeyFormatterCache.set(tzIana, formatter);
  }
  // en-CA formats as YYYY-MM-DD directly.
  return formatter.format(new Date(utcMs));
}

const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** The local wall-clock time (`"2:40 PM"`) a UTC instant reads as in the given zone. */
export function formatLocalTime(utcMs: number, tzIana: string): string {
  let formatter = timeFormatterCache.get(tzIana);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzIana,
      hour: 'numeric',
      minute: '2-digit',
    });
    timeFormatterCache.set(tzIana, formatter);
  }
  return formatter.format(new Date(utcMs));
}

const timeOfDayFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The local 24-hour wall-clock time (`"14:40"`) a UTC instant reads as in
 * the given zone — `T.18`'s Trip Mode resolver compares this directly
 * against `itineraryItems.plannedTime` (same `"HH:mm"` shape, so a plain
 * string comparison is a correct chronological comparison within a single
 * calendar day, same "lexicographic order on zero-padded keys is
 * chronological order" convention `_lib/dates.ts`'s `compareDateKeys` names
 * for date keys). Never used across a day boundary — `localDateKey` is what
 * decides *which* day "now" falls on first.
 */
export function localTimeOfDay(utcMs: number, tzIana: string): string {
  let formatter = timeOfDayFormatterCache.get(tzIana);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tzIana,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timeOfDayFormatterCache.set(tzIana, formatter);
  }
  // en-GB + hourCycle: 'h23' formats as zero-padded 24-hour "HH:mm" directly.
  return formatter.format(new Date(utcMs));
}
