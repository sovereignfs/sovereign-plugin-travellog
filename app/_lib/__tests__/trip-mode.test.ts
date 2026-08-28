import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createItineraryItem } from '../itinerary-items';
import { createPlace } from '../places';
import { createStop, listTripDays } from '../stops';
import {
  formatCountdown,
  listReminderCandidateStops,
  resolveActiveStop,
  resolveTripModeToday,
} from '../trip-mode';
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

  it('carries a place-backed item’s coordinates, for the maps hand-off — null for a title-only item', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a trip day');

    await createItineraryItem(t.travellog, day.id, trip.id, { placeId, plannedTime: '09:00' });
    await createItineraryItem(t.travellog, day.id, trip.id, { title: 'Free time', plannedTime: '11:00' });

    const result = await resolveTripModeToday(
      t.travellog,
      stop.id,
      Date.parse('2026-06-10T06:00:00Z'),
      'UTC',
    );
    // 'Belém Tower' seeded in beforeEach with no explicit lat/lng, so both
    // resolve to null here too — the point under test is that a place-backed
    // item's coordinates pass through *at all* (vs. being dropped by the
    // query), not any particular non-null value.
    expect(result?.items[0]).toMatchObject({ placeId, placeLat: null, placeLng: null });
    expect(result?.items[1]).toMatchObject({ title: 'Free time', placeId: null, placeLat: null, placeLng: null });
  });
});

describe('resolveActiveStop (T.19)', () => {
  it('returns null for a trip with no stops', async () => {
    const trip = await createTrip(t.travellog, actor, 'Someday trip');
    expect(await resolveActiveStop(t.travellog, trip.id, '2026-06-10')).toBeNull();
  });

  it('returns the stop whose [arriveDate, departDate] range covers the given date', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });

    for (const dateKey of ['2026-06-10', '2026-06-11', '2026-06-12']) {
      const result = await resolveActiveStop(t.travellog, trip.id, dateKey);
      expect(result?.stopId).toBe(stop.id);
      expect(result?.placeName).toBe('Belém Tower');
    }
  });

  it('returns null just before arrival and just after departure', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await createStop(t.travellog, trip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });

    expect(await resolveActiveStop(t.travellog, trip.id, '2026-06-09')).toBeNull();
    expect(await resolveActiveStop(t.travellog, trip.id, '2026-06-13')).toBeNull();
  });

  it('picks the right stop out of several, and null in a gap between two stops', async () => {
    const trip = await createTrip(t.travellog, actor, 'Two-stop trip');
    const place2 = await createPlace(t.travellog, actor, { name: 'Porto', source: 'manual' });
    const stop1 = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-11',
    });
    const stop2 = await createStop(t.travellog, trip.id, {
      placeId: place2.id,
      arriveDate: '2026-06-13',
      departDate: '2026-06-14',
    });

    expect((await resolveActiveStop(t.travellog, trip.id, '2026-06-10'))?.stopId).toBe(stop1.id);
    expect((await resolveActiveStop(t.travellog, trip.id, '2026-06-14'))?.stopId).toBe(stop2.id);
    // 2026-06-12 falls in the gap between the two stops — no leg travels through it.
    expect(await resolveActiveStop(t.travellog, trip.id, '2026-06-12')).toBeNull();
  });

  it('scopes to the given trip — another trip’s stop never leaks in', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip A');
    const otherTrip = await createTrip(t.travellog, actor, 'Trip B');
    await createStop(t.travellog, otherTrip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-10' });

    expect(await resolveActiveStop(t.travellog, trip.id, '2026-06-10')).toBeNull();
  });
});

describe('listReminderCandidateStops (T.20)', () => {
  it('includes a stop dated today, in the generous UTC ± 1 day window', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });

    const candidates = await listReminderCandidateStops(t.travellog, Date.parse('2026-06-10T12:00:00Z'));
    expect(candidates.map((c) => c.stopId)).toContain(stop.id);
  });

  it('includes a stop exactly at the ± 1 day window edge, excludes one just beyond it', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const edgeStop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-09',
      departDate: '2026-06-09',
    });
    const beyondPlace = await createPlace(t.travellog, actor, { name: 'Porto', source: 'manual' });
    const beyondStop = await createStop(t.travellog, trip.id, {
      placeId: beyondPlace.id,
      arriveDate: '2026-06-08',
      departDate: '2026-06-08',
    });

    // 'now' is noon on 2026-06-10 — the window is [06-09, 06-11].
    const candidates = await listReminderCandidateStops(t.travellog, Date.parse('2026-06-10T12:00:00Z'));
    const ids = candidates.map((c) => c.stopId);
    expect(ids).toContain(edgeStop.id);
    expect(ids).not.toContain(beyondStop.id);
  });

  it('excludes a stop weeks away', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-07-01',
      departDate: '2026-07-03',
    });

    const candidates = await listReminderCandidateStops(t.travellog, Date.parse('2026-06-10T12:00:00Z'));
    expect(candidates.map((c) => c.stopId)).not.toContain(stop.id);
  });

  it('carries the place’s coordinates and the trip’s owner — null coordinates for a coordinate-free place', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId, // seeded with no lat/lng in beforeEach
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });

    const [candidate] = await listReminderCandidateStops(t.travellog, Date.parse('2026-06-10T12:00:00Z'));
    expect(candidate).toMatchObject({
      stopId: stop.id,
      tripId: trip.id,
      tripOwnerId: actor.userId,
      placeLat: null,
      placeLng: null,
    });
  });

  it('passes through real coordinates when the place has them', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const geocodedPlace = await createPlace(t.travellog, actor, {
      name: 'Torre de Belém',
      source: 'manual',
      lat: 38.691586,
      lng: -9.2159288,
    });
    await createStop(t.travellog, trip.id, {
      placeId: geocodedPlace.id,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });

    const candidates = await listReminderCandidateStops(t.travellog, Date.parse('2026-06-10T12:00:00Z'));
    const candidate = candidates.find((c) => c.placeLat !== null);
    expect(candidate).toMatchObject({ placeLat: 38.691586, placeLng: -9.2159288 });
  });

  it('scans across every trip and owner — not scoped to one actor', async () => {
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    const trip = await createTrip(t.travellog, otherActor, 'Someone else’s trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });

    const candidates = await listReminderCandidateStops(t.travellog, Date.parse('2026-06-10T12:00:00Z'));
    expect(candidates).toContainEqual(expect.objectContaining({ stopId: stop.id, tripOwnerId: 'user-2' }));
  });
});

describe('formatCountdown (T.20)', () => {
  it('formats under an hour as plain minutes', () => {
    expect(formatCountdown(0)).toBe('0 min');
    expect(formatCountdown(45)).toBe('45 min');
  });

  it('formats exactly on the hour with no minutes remainder', () => {
    expect(formatCountdown(60)).toBe('1h');
    expect(formatCountdown(180)).toBe('3h');
  });

  it('formats a partial hour as hours and minutes', () => {
    expect(formatCountdown(90)).toBe('1h 30m');
    expect(formatCountdown(200)).toBe('3h 20m');
  });
});
