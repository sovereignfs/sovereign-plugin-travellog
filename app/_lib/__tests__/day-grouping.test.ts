import { describe, expect, it } from 'vitest';
import { groupByDay } from '../day-grouping';

// The viewer's own local date and year — supplied by the caller (`useTodayKey`), never read from the clock here.
const TODAY_KEY = '2026-08-27';
const CURRENT_YEAR = 2026;

function visit(id: string, happenedAt: number, tzIana = 'UTC') {
  return { id, happenedAt, tzIana };
}

describe('groupByDay', () => {
  it('labels today and yesterday, and groups consecutive same-day items together', () => {
    const groups = groupByDay(
      [
        visit('a', Date.UTC(2026, 7, 27, 10, 0)), // today
        visit('b', Date.UTC(2026, 7, 27, 8, 0)), // today, same day as a
        visit('c', Date.UTC(2026, 7, 26, 20, 0)), // yesterday
      ],
      TODAY_KEY,
      CURRENT_YEAR,
    );

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['c']);
  });

  it('formats an older date plainly, without a year for the current year', () => {
    const groups = groupByDay([visit('a', Date.UTC(2026, 7, 20, 12, 0))], TODAY_KEY, CURRENT_YEAR);
    expect(groups[0]?.label).toBe('Aug 20');
  });

  it('includes the year for a date in a different year (a decade-old import)', () => {
    const groups = groupByDay([visit('a', Date.UTC(2016, 7, 20, 12, 0))], TODAY_KEY, CURRENT_YEAR);
    expect(groups[0]?.label).toBe('Aug 20, 2016');
  });

  it('groups by each visit’s own local day, not a shared server/viewer zone', () => {
    // 2026-08-27 23:30 UTC is already 2026-08-28 in a +2h zone.
    const groups = groupByDay(
      [
        visit('utc-late', Date.UTC(2026, 7, 27, 23, 30), 'UTC'),
        visit('plus2-next-day', Date.UTC(2026, 7, 27, 23, 30), 'Europe/Berlin'),
      ],
      TODAY_KEY,
      CURRENT_YEAR,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toBe('Today');
    expect(groups[1]?.label).toBe('Aug 28');
  });

  it('uses the viewer’s local date for "Today" — the same instant reads as a different day in another zone', () => {
    const late = visit('a', Date.UTC(2026, 7, 27, 23, 30), 'UTC'); // 2026-08-27 in UTC
    expect(groupByDay([late], '2026-08-27', 2026)[0]?.label).toBe('Today');
    // A viewer in a zone already on the 28th sees it as yesterday.
    expect(groupByDay([late], '2026-08-28', 2026)[0]?.label).toBe('Yesterday');
  });

  it('returns an empty array for no visits', () => {
    expect(groupByDay([], TODAY_KEY, CURRENT_YEAR)).toEqual([]);
  });
});
