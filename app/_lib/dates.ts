/**
 * Pure `YYYY-MM-DD` calendar-date arithmetic for `T.10`'s trip/stop/day
 * tables (`trips.startDate`/`endDate`, `stops.arriveDate`/`departDate`,
 * `tripDays.date`) — deliberately separate from `./timezone.ts`, which
 * converts a UTC *instant* into a zone's local date/time. Nothing here
 * touches an instant or a timezone at all: a stop has no single timezone of
 * its own in phase 1 (SPEC.md's Data model notes), so "arrives September
 * 1st" is stored and manipulated as a bare calendar date, never as
 * midnight-in-some-zone.
 *
 * `T.11`'s own review checklist calls out DST explicitly ("creating a
 * 5-day stop produces 5 trip_day rows with correct dates across a DST
 * transition... timezone bugs are the class of bug this plugin is most
 * exposed to") — every function here is anchored at UTC noon specifically
 * to make that a non-issue: incrementing by exactly one UTC day (86_400_000
 * ms) from a UTC-noon instant can never cross a local DST boundary, because
 * there is no local zone in this calculation at all. The classic footgun
 * this avoids is parsing `"2026-03-08"` as local midnight (`new
 * Date("2026-03-08T00:00")`) and incrementing from there — in a zone
 * observing DST, that arithmetic can land on the wrong calendar date
 * depending on the host machine's own timezone, which is exactly the class
 * of bug that must never depend on where the server happens to be running.
 */

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Longest single stop this plugin will materialize `trip_days` rows for
 * (inclusive day count). A stop is one place with an arrival and a
 * departure; a year at one address is a sanity ceiling, not a product
 * limit anyone will hit. Load-bearing for safety, not UX: `enumerateDateKeys`
 * inserts one `trip_days` row per day inside one transaction, and a server
 * action is a public endpoint — without a cap, a crafted `9999-12-31`
 * departure is a multi-million-row write.
 */
export const MAX_STOP_DAYS = 366;

/**
 * One fixed locale for every date/time string this plugin renders. Several
 * of these render during SSR of client components (trip cards, stop chips,
 * day headings) — `toLocaleDateString(undefined, …)` would use the *server's*
 * default locale there and the *browser's* on hydration, producing "Sep 14"
 * vs "14 Sept" mismatches and text flicker. Pinning one locale keeps SSR
 * and client output byte-identical; real localization is a later,
 * platform-level concern (there is no i18n primitive yet).
 */
export const DISPLAY_LOCALE = 'en-US';

/** UTC noon for a `YYYY-MM-DD` key — never local midnight (see file header). */
function toUtcNoon(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
}

function toDateKey(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** A real, well-formed `YYYY-MM-DD` calendar date — not just pattern-shaped (rejects e.g. `2026-02-30`). */
export function isValidDateKey(key: string): boolean {
  if (!DATE_KEY_PATTERN.test(key)) return false;
  const date = toUtcNoon(key);
  return toDateKey(date) === key;
}

/** Lexicographic order on zero-padded `YYYY-MM-DD` keys is chronological order — this just names that fact at call sites. */
export function compareDateKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** `days` may be negative. DST-safe — see file header. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  return toDateKey(new Date(toUtcNoon(dateKey).getTime() + days * MS_PER_DAY));
}

/**
 * Every calendar date from `startKey` to `endKey`, inclusive — a stop
 * arriving Monday and departing Friday is 5 days (Mon–Fri), not 4.
 * Throws if `endKey` is before `startKey` (the caller validates dates
 * before calling this, not the other way around).
 */
export function enumerateDateKeys(startKey: string, endKey: string): string[] {
  // Malformed keys are rejected outright rather than compared: a bare
  // lexicographic loop over a non-date string (`'abc'` → `'NaN-NaN-NaN'`)
  // never reaches its end key and spins forever, synchronously, on the
  // server — reproduced before this guard existed.
  if (!isValidDateKey(startKey) || !isValidDateKey(endKey)) {
    throw new Error(`enumerateDateKeys: malformed date key (${startKey}, ${endKey})`);
  }
  if (compareDateKeys(startKey, endKey) > 0) {
    throw new Error(`enumerateDateKeys: start (${startKey}) is after end (${endKey})`);
  }
  const span = daysBetweenDateKeys(startKey, endKey) + 1;
  if (span > MAX_STOP_DAYS) {
    throw new Error(`enumerateDateKeys: range of ${String(span)} days exceeds MAX_STOP_DAYS`);
  }
  const keys: string[] = [];
  let cursor = startKey;
  while (compareDateKeys(cursor, endKey) <= 0) {
    keys.push(cursor);
    cursor = addDaysToDateKey(cursor, 1);
  }
  return keys;
}

/**
 * Whole calendar days between two dates — `daysBetweenDateKeys('2026-06-10', '2026-06-10')`
 * is `0` (a single-day range), `daysBetweenDateKeys('2026-06-10', '2026-06-15')`
 * is `5`. Negative if `endKey` is before `startKey`. `T.12`'s auto-link
 * "narrower range wins" rule (SPEC.md's Data model notes) uses this to
 * compare trip date-range widths without allocating `enumerateDateKeys`'
 * full array just to measure it.
 */
export function daysBetweenDateKeys(startKey: string, endKey: string): number {
  return Math.round((toUtcNoon(endKey).getTime() - toUtcNoon(startKey).getTime()) / MS_PER_DAY);
}

/**
 * Today's date in UTC — the reference point the trip status resolver
 * compares against. A trip's stops may span several zones (or none at all,
 * for a title-only itinerary item), so there is no single "local today" to
 * anchor on in phase 1; UTC is the documented, simple choice. Not
 * addressed in phase 1: a trip whose status flips a few hours earlier or
 * later than a traveler's own local midnight would expect.
 */
export function todayDateKey(): string {
  return toDateKey(new Date());
}

/**
 * `T.13`'s trip-card date range, e.g. `"Sep 14–18"` (same month/year) or
 * `"Aug 30 – Sep 2"` (crossing a month boundary) or `"Dec 30, 2026 – Jan 2, 2027"`
 * (crossing a year boundary). UTC-noon anchored for the same reason every
 * other function here is — see file header.
 */
export function formatDateRange(startKey: string, endKey: string): string {
  const start = toUtcNoon(startKey);
  const end = toUtcNoon(endKey);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();

  const dayOnly = (d: Date) =>
    d.toLocaleDateString(DISPLAY_LOCALE, { day: 'numeric', timeZone: 'UTC' });
  const monthDay = (d: Date) =>
    d.toLocaleDateString(DISPLAY_LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthDayYear = (d: Date) =>
    d.toLocaleDateString(DISPLAY_LOCALE, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });

  if (sameMonth) return `${monthDay(start)}–${dayOnly(end)}`;
  if (sameYear) return `${monthDay(start)} – ${monthDay(end)}`;
  return `${monthDayYear(start)} – ${monthDayYear(end)}`;
}

/** `T.16`'s day-group heading, e.g. `"Tue, Aug 26"` — UTC-noon anchored for the same reason every other function here is (see file header). */
export function formatDayHeading(dateKey: string): string {
  return toUtcNoon(dateKey).toLocaleDateString(DISPLAY_LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** `"Tuesday, August 26, 2026"` — the check-in detail panel's full date line. */
export function formatLongDate(dateKey: string): string {
  return toUtcNoon(dateKey).toLocaleDateString(DISPLAY_LOCALE, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * `"Aug 26"` this year, `"Aug 26, 2019"` otherwise — the timeline's
 * day-group heading for anything that isn't today/yesterday. `currentYear`
 * is a parameter (not `new Date()`) so SSR and hydration agree.
 */
export function formatShortDate(dateKey: string, currentYear: number): string {
  const date = toUtcNoon(dateKey);
  return date.toLocaleDateString(DISPLAY_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: date.getUTCFullYear() !== currentYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}
