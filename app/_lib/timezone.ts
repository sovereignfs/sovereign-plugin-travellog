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

/**
 * The UTC instant at which the wall clock in `tzIana` reads `HH:mm` on
 * `dateKey` — the inverse of `localDateKey` + `localTimeOfDay`. Solved
 * iteratively: assume the zone's offset at UTC-midnight-ish, re-derive the
 * offset at the resulting instant, and correct once more — which converges
 * for every real zone because offsets only change at transitions, and a
 * second pass lands on the correct side of one. `T.18`'s countdown uses
 * this so "minutes until 18:00" is a real difference of instants and stays
 * right across a DST transition day (a bare wall-clock subtraction is an
 * hour off on those two days a year). On a spring-forward gap (a wall
 * time that never occurs), the instant just after the gap is returned.
 */
export function zonedTimeToUtcMs(dateKey: string, timeOfDay: string, tzIana: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hours, minutes] = timeOfDay.split(':').map(Number);
  const asIfUtc = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hours ?? 0, minutes ?? 0);

  let guess = asIfUtc - offsetMinutesAt(asIfUtc, tzIana) * 60_000;
  guess = asIfUtc - offsetMinutesAt(guess, tzIana) * 60_000;
  return guess;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** The zone's UTC offset in minutes (east-positive) at a given instant. */
export function offsetMinutesAt(utcMs: number, tzIana: string): number {
  let formatter = partsFormatterCache.get(tzIana);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzIana,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(tzIana, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return Math.round((wallAsUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

const zoneNameFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * A short zone label for an instant (`"PDT"`, `"GMT+9"`) — shown next to a
 * check-in's local time when the viewer's own zone differs, so a Tokyo
 * check-in read from London doesn't present a bare "2:40 PM".
 */
export function zoneAbbreviation(utcMs: number, tzIana: string): string {
  let formatter = zoneNameFormatterCache.get(tzIana);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: tzIana, timeZoneName: 'short' });
    zoneNameFormatterCache.set(tzIana, formatter);
  }
  const part = formatter.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? tzIana;
}
