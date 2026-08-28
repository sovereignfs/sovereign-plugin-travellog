import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDaysToDateKey,
  compareDateKeys,
  enumerateDateKeys,
  isValidDateKey,
  todayDateKey,
} from '../dates';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isValidDateKey', () => {
  it('accepts a real calendar date', () => {
    expect(isValidDateKey('2026-03-08')).toBe(true);
  });

  it('rejects a non-existent calendar date (Feb 30)', () => {
    expect(isValidDateKey('2026-02-30')).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    expect(isValidDateKey('not-a-date')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('')).toBe(false);
  });

  it('accepts Feb 29 on a leap year, rejects it on a non-leap year', () => {
    expect(isValidDateKey('2028-02-29')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false);
  });
});

describe('compareDateKeys', () => {
  it('orders chronologically across a year boundary', () => {
    expect(compareDateKeys('2026-12-31', '2027-01-01')).toBeLessThan(0);
    expect(compareDateKeys('2027-01-01', '2026-12-31')).toBeGreaterThan(0);
    expect(compareDateKeys('2026-06-15', '2026-06-15')).toBe(0);
  });
});

describe('addDaysToDateKey (T.11 review checklist: DST transitions)', () => {
  it('increments across the US spring-forward transition (2026-03-08)', () => {
    expect(addDaysToDateKey('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDaysToDateKey('2026-03-08', 1)).toBe('2026-03-09');
  });

  it('increments across the US fall-back transition (2026-11-01)', () => {
    expect(addDaysToDateKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysToDateKey('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('crosses a month and year boundary correctly', () => {
    expect(addDaysToDateKey('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysToDateKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('supports negative offsets', () => {
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('produces the identical result regardless of the host process timezone', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati'); // UTC+14
    const forward = addDaysToDateKey('2026-03-08', 1);
    vi.stubEnv('TZ', 'Etc/GMT+12'); // UTC-12
    const backward = addDaysToDateKey('2026-03-08', 1);
    expect(forward).toBe('2026-03-09');
    expect(backward).toBe('2026-03-09');
  });
});

describe('enumerateDateKeys (T.11 review checklist: "a 5-day stop produces 5 trip_day rows")', () => {
  it('a stop arriving Monday and departing Friday is 5 days, inclusive on both ends', () => {
    // 2026-08-31 is a Monday.
    const days = enumerateDateKeys('2026-08-31', '2026-09-04');
    expect(days).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
    expect(days).toHaveLength(5);
  });

  it('a single-day stop produces exactly one day', () => {
    expect(enumerateDateKeys('2026-06-15', '2026-06-15')).toEqual(['2026-06-15']);
  });

  it('spans the US DST transitions with no skipped or duplicated day', () => {
    const spring = enumerateDateKeys('2026-03-06', '2026-03-10');
    expect(spring).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);

    const fall = enumerateDateKeys('2026-10-30', '2026-11-03');
    expect(fall).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('throws when the end date is before the start date', () => {
    expect(() => enumerateDateKeys('2026-06-15', '2026-06-10')).toThrow();
  });
});

describe('todayDateKey', () => {
  it('returns a well-formed date key', () => {
    expect(isValidDateKey(todayDateKey())).toBe(true);
  });
});
