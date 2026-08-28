import { describe, expect, it } from 'vitest';
import { groupByDay } from '../day-grouping';

const REFERENCE_NOW = Date.UTC(2026, 7, 27, 15, 0, 0); // 2026-08-27, 15:00 UTC

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
      REFERENCE_NOW,
    );

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['c']);
  });

  it('formats an older date plainly, without a year for the current year', () => {
    const groups = groupByDay([visit('a', Date.UTC(2026, 7, 20, 12, 0))], REFERENCE_NOW);
    expect(groups[0]?.label).toBe('Aug 20');
  });

  it('includes the year for a date in a different year (a decade-old import)', () => {
    const groups = groupByDay([visit('a', Date.UTC(2016, 7, 20, 12, 0))], REFERENCE_NOW);
    expect(groups[0]?.label).toBe('Aug 20, 2016');
  });

  it('groups by each visit’s own local day, not a shared server/viewer zone', () => {
    // 2026-08-27 23:30 UTC is already 2026-08-28 in a +2h zone.
    const groups = groupByDay(
      [
        visit('utc-late', Date.UTC(2026, 7, 27, 23, 30), 'UTC'),
        visit('plus2-next-day', Date.UTC(2026, 7, 27, 23, 30), 'Europe/Berlin'),
      ],
      REFERENCE_NOW,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toBe('Today');
    expect(groups[1]?.label).toBe('Aug 28');
  });

  it('returns an empty array for no visits', () => {
    expect(groupByDay([], REFERENCE_NOW)).toEqual([]);
  });
});
