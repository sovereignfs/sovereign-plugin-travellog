import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createItineraryItem } from '../itinerary-items';
import { createPlace } from '../places';
import { createStop, listTripDays } from '../stops';
import { resolveTripModeToday } from '../trip-mode';
import { createTrip } from '../trips';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;
let placeId: string;

beforeEach(async () => {
  t = await createTestDb();
  const place = await createPlace(t.travellog, actor, { name: 'Belém Tower', source: 'manual' });
  placeId = place.id;
});

afterEach(() => {
  t.close();
});

describe('resolveTripModeToday (T.18 review checklist)', () => {
  it('returns null when today is outside the stop’s date range', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });

    // 2026-06-20 UTC noon is well outside the stop's range in any zone.
    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-20T12:00:00Z'),
      'UTC',
    );
    expect(result).toBeNull();
  });

  it('a real day with zero itinerary items is an empty state, not null', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });

    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T12:00:00Z'),
      'UTC',
    );
    expect(result).not.toBeNull();
    expect(result?.items).toEqual([]);
    expect(result?.nextItem).toBeNull();
    expect(result?.countdownMinutes).toBeNull();
  });

  it('returns items in position order, un-timed items included alongside timed ones', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a trip day');

    await createItineraryItem(t.travellog, day.id, trip.id, { title: 'Breakfast' });
    await createItineraryItem(t.travellog, day.id, trip.id, { placeId, plannedTime: '10:00' });

    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T06:00:00Z'), // 06:00 UTC = 06:00 in 'UTC' zone, before both items conceptually
      'UTC',
    );
    expect(result?.items.map((i) => i.title ?? i.placeName)).toEqual(['Breakfast', 'Belém Tower']);
  });

  it('"next" is the first item by position with a planned time strictly after now — skips un-timed items and already-past times', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a trip day');

    await createItineraryItem(t.travellog, day.id, trip.id, { placeId, plannedTime: '08:00' }); // already past
    await createItineraryItem(t.travellog, day.id, trip.id, { title: 'Free time' }); // un-timed, never "next"
    await createItineraryItem(t.travellog, day.id, trip.id, {
      placeId,
      title: 'Lunch',
      plannedTime: '13:00',
    });
    await createItineraryItem(t.travellog, day.id, trip.id, { placeId, plannedTime: '18:00' });

    // 10:30 UTC — after the 08:00 item, before the 13:00 and 18:00 ones.
    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T10:30:00Z'),
      'UTC',
    );
    expect(result?.nextItem?.plannedTime).toBe('13:00');
    expect(result?.countdownMinutes).toBe(150); // 10:30 -> 13:00
  });

  it('an item planned for exactly "now" has already arrived, not "next"', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a trip day');

    await createItineraryItem(t.travellog, day.id, trip.id, { placeId, plannedTime: '13:00' });

    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T13:00:00Z'),
      'UTC',
    );
    expect(result?.nextItem).toBeNull();
    expect(result?.countdownMinutes).toBeNull();
  });

  it('nothing left today returns a null nextItem, not the next day’s item', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-11',
    });
    const days = await listTripDays(t.travellog, stop.id);
    const day1 = days.find((d) => d.date === '2026-06-10');
    const day2 = days.find((d) => d.date === '2026-06-11');
    if (!day1 || !day2) throw new Error('expected both trip days');

    await createItineraryItem(t.travellog, day1.id, trip.id, { placeId, plannedTime: '09:00' });
    await createItineraryItem(t.travellog, day2.id, trip.id, { placeId, plannedTime: '09:00' });

    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T20:00:00Z'), // late on day 1, well past its only item
      'UTC',
    );
    expect(result?.tripDayId).toBe(day1.id);
    expect(result?.nextItem).toBeNull();
  });

  it('resolves "today" by the stop’s local date, not UTC’s — a zone far ahead of UTC (date-line crossing)', async () => {
    const trip = await createTrip(t.travellog, actor, 'Pacific crossing');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-15',
      departDate: '2026-06-15',
    });

    // 2026-06-14T22:00:00Z is still 2026-06-14 in UTC, but Pacific/Kiritimati
    // (UTC+14) reads this same instant as 2026-06-15 12:00 local — the day
    // this stop is actually dated. A naive UTC-date lookup would find nothing.
    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-14T22:00:00Z'),
      'Pacific/Kiritimati',
    );
    expect(result).not.toBeNull();
    expect(result?.date).toBe('2026-06-15');
  });

  it('the local day boundary (11:59pm -> 12:01am) correctly flips which trip_day is "today"', async () => {
    const trip = await createTrip(t.travellog, actor, 'Boundary trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-11',
    });
    const days = await listTripDays(t.travellog, stop.id);
    const day1 = days.find((d) => d.date === '2026-06-10');
    const day2 = days.find((d) => d.date === '2026-06-11');
    if (!day1 || !day2) throw new Error('expected both trip days');

    // Europe/Lisbon is UTC+1 in June (WEST). 22:59 UTC = 23:59 local on the
    // 10th; two minutes later, 23:01 UTC = 00:01 local on the 11th.
    const justBeforeMidnight = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T22:59:00Z'),
      'Europe/Lisbon',
    );
    const justAfterMidnight = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T23:01:00Z'),
      'Europe/Lisbon',
    );

    expect(justBeforeMidnight?.tripDayId).toBe(day1.id);
    expect(justBeforeMidnight?.date).toBe('2026-06-10');
    expect(justAfterMidnight?.tripDayId).toBe(day2.id);
    expect(justAfterMidnight?.date).toBe('2026-06-11');
  });

  it('scopes to the given stop — another stop’s (or trip’s) day never leaks in', async () => {
    const trip = await createTrip(t.travellog, actor, 'Two-stop trip');
    const place2Result = await createPlace(t.travellog, actor, { name: 'Porto', source: 'manual' });
    const stop1 = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    const stop2 = await createStop(t.travellog, trip.id, {
      placeId: place2Result.id,
      arriveDate: '2026-06-11',
      departDate: '2026-06-11',
    });
    const [stop1Day] = await listTripDays(t.travellog, stop1.id);
    if (!stop1Day) throw new Error('expected a trip day');
    await createItineraryItem(t.travellog, stop1Day.id, trip.id, { placeId, plannedTime: '09:00' });

    // Asking stop2 about 2026-06-10 (stop1's day, not stop2's) must find nothing.
    const result = await resolveTripModeToday(
      t.travellog,
      stop2.id,
      Date.parse('2026-06-10T12:00:00Z'),
      'UTC',
    );
    expect(result).toBeNull();
  });
});
