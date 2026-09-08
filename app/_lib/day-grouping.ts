/**
 * Groups an already-reverse-chronological list of timeline items by the
 * calendar day they happened on **in each item's own zone** (`T.6`'s
 * day-grouped timeline). Pure — takes the viewer's "today" and current
 * year as parameters rather than reading the clock, so this is trivially
 * testable with fixed dates, has no hidden dependency on the caller's own
 * timezone, and — because the caller supplies a hydration-safe `todayKey`
 * (`use-today-key.ts`) — renders identically on the server and the client.
 */
import { addDaysToDateKey, formatShortDate } from './dates';
import { localDateKey } from './timezone';

export interface DayGroup<T> {
  dateKey: string;
  /** "Today" / "Yesterday" / a plain formatted date — never a raw ISO string. */
  label: string;
  items: T[];
}

/**
 * `todayKey` is the *viewer's* local calendar date. It used to be derived
 * from `Date.now()` in UTC, which put every evening's check-ins under
 * "Yesterday" for viewers west of UTC and late-night ones under a date
 * that read as tomorrow east of it — on the plugin's primary screen.
 */
export function groupByDay<T extends { happenedAt: number; tzIana: string }>(
  items: T[],
  todayKey: string,
  currentYear: number,
): Array<DayGroup<T>> {
  const yesterdayKey = addDaysToDateKey(todayKey, -1);

  const groups: Array<DayGroup<T>> = [];
  for (const item of items) {
    const dateKey = localDateKey(item.happenedAt, item.tzIana);
    const last = groups[groups.length - 1];
    if (last && last.dateKey === dateKey) {
      last.items.push(item);
      continue;
    }
    const label =
      dateKey === todayKey
        ? 'Today'
        : dateKey === yesterdayKey
          ? 'Yesterday'
          : formatShortDate(dateKey, currentYear);
    groups.push({ dateKey, label, items: [item] });
  }
  return groups;
}
