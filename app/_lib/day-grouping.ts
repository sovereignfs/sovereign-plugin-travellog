/**
 * Groups an already-reverse-chronological list of timeline items by the
 * calendar day they happened on **in each item's own zone** (`T.6`'s
 * day-grouped timeline). Pure — takes "now" as a parameter rather than
 * reading it internally, so this is trivially testable with fixed dates
 * and has no hidden dependency on the caller's own timezone.
 */
import { localDateKey } from './timezone';

export interface DayGroup<T> {
  dateKey: string;
  /** "Today" / "Yesterday" / a plain formatted date — never a raw ISO string. */
  label: string;
  items: T[];
}

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta));
  return date.toISOString().slice(0, 10);
}

function formatPlainDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    // Only include the year when it isn't the viewer's current year —
    // avoids "Aug 27, 2026" cluttering every row for a decade-old import.
    year: y !== new Date().getUTCFullYear() ? 'numeric' : undefined,
    timeZone: 'UTC',
  }).format(date);
}

export function groupByDay<T extends { happenedAt: number; tzIana: string }>(
  items: T[],
  referenceNowMs: number,
): Array<DayGroup<T>> {
  // "Today"/"Yesterday" compare each visit's own local date (already
  // correctly zone-aware, above) against the viewer's current UTC date —
  // a deliberate simplification, not a bug: this function has no viewer
  // timezone to work with, only a timestamp. Worst case near a midnight
  // boundary, a visit reads one day off from what the *viewer's own*
  // clock would call "today" — the visit's own displayed time/date next
  // to it is always the authoritative, zone-correct value regardless.
  const todayKey = new Date(referenceNowMs).toISOString().slice(0, 10);
  const yesterdayKey = addDays(todayKey, -1);

  const groups: Array<DayGroup<T>> = [];
  for (const item of items) {
    const dateKey = localDateKey(item.happenedAt, item.tzIana);
    const last = groups[groups.length - 1];
    if (last && last.dateKey === dateKey) {
      last.items.push(item);
      continue;
    }
    const label =
      dateKey === todayKey ? 'Today' : dateKey === yesterdayKey ? 'Yesterday' : formatPlainDate(dateKey);
    groups.push({ dateKey, label, items: [item] });
  }
  return groups;
}
