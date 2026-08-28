import { describe, expect, it } from 'vitest';
import { resolveTripStatus } from '../trip-status';

describe('resolveTripStatus (T.11 review checklist: all four states + boundary transitions)', () => {
  it('is planning when the trip has zero stops', () => {
    expect(
      resolveTripStatus({ hasStops: false, startDate: null, endDate: null }, '2026-06-01'),
    ).toBe('planning');
  });

  it('is upcoming the day before start', () => {
    expect(
      resolveTripStatus(
        { hasStops: true, startDate: '2026-06-10', endDate: '2026-06-15' },
        '2026-06-09',
      ),
    ).toBe('upcoming');
  });

  it('is ongoing on the exact start date (boundary)', () => {
    expect(
      resolveTripStatus(
        { hasStops: true, startDate: '2026-06-10', endDate: '2026-06-15' },
        '2026-06-10',
      ),
    ).toBe('ongoing');
  });

  it('is ongoing on the exact end date (boundary)', () => {
    expect(
      resolveTripStatus(
        { hasStops: true, startDate: '2026-06-10', endDate: '2026-06-15' },
        '2026-06-15',
      ),
    ).toBe('ongoing');
  });

  it('is ongoing on a day strictly between start and end', () => {
    expect(
      resolveTripStatus(
        { hasStops: true, startDate: '2026-06-10', endDate: '2026-06-15' },
        '2026-06-12',
      ),
    ).toBe('ongoing');
  });

  it('is completed the day after end (boundary)', () => {
    expect(
      resolveTripStatus(
        { hasStops: true, startDate: '2026-06-10', endDate: '2026-06-15' },
        '2026-06-16',
      ),
    ).toBe('completed');
  });

  it('is ongoing for a single-day trip on that exact day', () => {
    expect(
      resolveTripStatus(
        { hasStops: true, startDate: '2026-06-10', endDate: '2026-06-10' },
        '2026-06-10',
      ),
    ).toBe('ongoing');
  });
});
