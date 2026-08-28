import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createTrip } from '../trips';
import {
  createStop,
  deleteStop,
  listStops,
  listTripDays,
  reorderStop,
  TripDayHasItemsError,
  updateStop,
} from '../stops';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;
let tripId: string;
let placeAId: string;
let placeBId: string;

beforeEach(async () => {
  t = await createTestDb();
  const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
  tripId = trip.id;

  const now = Date.now();
  placeAId = 'place-a';
  placeBId = 'place-b';
  await t.db.insert(schema.places).values([
    {
      id: placeAId,
      tenantId: actor.tenantId,
      name: 'Lisbon',
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: placeBId,
      tenantId: actor.tenantId,
      name: 'Porto',
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

afterEach(() => {
  t.close();
});

async function getTrip() {
  const [row] = await t.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
  if (!row) throw new Error('trip disappeared');
  return row;
}

describe('createStop (T.11 review checklist: 5-day stop → 5 trip_day rows, DST-safe)', () => {
  it('a stop arriving Monday and departing Friday produces exactly 5 trip_day rows with correct dates', async () => {
    // 2026-08-31 is a Monday.
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-04',
    });

    const days = await listTripDays(t.travellog, stop.id);
    expect(days.map((d) => d.date)).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
  });

  it('produces correct trip_day rows across the US DST spring-forward transition', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-03-06',
      departDate: '2026-03-10',
    });
    const days = await listTripDays(t.travellog, stop.id);
    expect(days.map((d) => d.date)).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('recomputes the trip’s denormalized start/end dates from the first stop', async () => {
    await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-02',
    });
    const trip = await getTrip();
    expect(trip.startDate).toBe('2026-08-31');
    expect(trip.endDate).toBe('2026-09-02');
  });

  it('a second stop extends the trip’s end date (last stop wins, by position)', async () => {
    await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-02',
    });
    await createStop(t.travellog, tripId, {
      placeId: placeBId,
      arriveDate: '2026-09-02',
      departDate: '2026-09-05',
    });
    const trip = await getTrip();
    expect(trip.startDate).toBe('2026-08-31'); // still the first stop's arrival
    expect(trip.endDate).toBe('2026-09-05'); // now the second (last) stop's departure
  });

  it('appends new stops at the end, in creation order', async () => {
    const first = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    const second = await createStop(t.travellog, tripId, {
      placeId: placeBId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-02',
    });
    const stops = await listStops(t.travellog, tripId);
    expect(stops.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it('rejects a stop that departs before it arrives', async () => {
    await expect(
      createStop(t.travellog, tripId, {
        placeId: placeAId,
        arriveDate: '2026-09-05',
        departDate: '2026-09-01',
      }),
    ).rejects.toThrow();
  });
});

describe('updateStop', () => {
  it('growing the date range adds new trip_day rows', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    await updateStop(t.travellog, tripId, stop.id, { departDate: '2026-09-03' });

    const days = await listTripDays(t.travellog, stop.id);
    expect(days.map((d) => d.date)).toEqual(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('shrinking the date range removes trip_day rows when none have itinerary items', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-03',
    });
    await updateStop(t.travellog, tripId, stop.id, { departDate: '2026-09-01' });

    const days = await listTripDays(t.travellog, stop.id);
    expect(days.map((d) => d.date)).toEqual(['2026-08-31', '2026-09-01']);
  });

  it('blocks shrinking the date range when a to-be-removed day still has itinerary items — nothing is written', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-03',
    });
    const days = await listTripDays(t.travellog, stop.id);
    const lastDay = days[days.length - 1];
    if (!lastDay) throw new Error('expected a last day');
    const now = Date.now();
    await t.db.insert(schema.itineraryItems).values({
      id: 'item-1',
      tripDayId: lastDay.id,
      tripId,
      placeId: placeAId,
      position: 1024,
      isFixed: 0,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      updateStop(t.travellog, tripId, stop.id, { departDate: '2026-09-01' }),
    ).rejects.toThrow(TripDayHasItemsError);

    // Nothing changed — the stop's own dates are untouched, the day survives.
    const [unchangedStop] = await t.db.select().from(schema.stops).where(eq(schema.stops.id, stop.id));
    expect(unchangedStop?.departDate).toBe('2026-09-03');
    // Aug 31 → Sep 3 inclusive is 4 days (Aug 31, Sep 1, Sep 2, Sep 3).
    expect(await listTripDays(t.travellog, stop.id)).toHaveLength(4);
  });

  it('changing only the place leaves trip_day rows untouched', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-02',
    });
    const before = await listTripDays(t.travellog, stop.id);
    await updateStop(t.travellog, tripId, stop.id, { placeId: placeBId });
    const after = await listTripDays(t.travellog, stop.id);
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
  });
});

describe('deleteStop', () => {
  it('deletes a stop with no itinerary items and recomputes trip dates', async () => {
    const stop1 = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    await createStop(t.travellog, tripId, {
      placeId: placeBId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-03',
    });

    await deleteStop(t.travellog, tripId, stop1.id);

    expect(await listStops(t.travellog, tripId)).toHaveLength(1);
    const trip = await getTrip();
    expect(trip.startDate).toBe('2026-09-01'); // only the remaining stop now
    expect(trip.endDate).toBe('2026-09-03');
  });

  it('deleting the last stop clears the trip back to planning (null dates)', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    await deleteStop(t.travellog, tripId, stop.id);
    const trip = await getTrip();
    expect(trip.startDate).toBeNull();
    expect(trip.endDate).toBeNull();
  });

  it('blocks deleting a stop whose days still have itinerary items', async () => {
    const stop = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a day');
    const now = Date.now();
    await t.db.insert(schema.itineraryItems).values({
      id: 'item-1',
      tripDayId: day.id,
      tripId,
      placeId: placeAId,
      position: 1024,
      isFixed: 0,
      createdAt: now,
      updatedAt: now,
    });

    await expect(deleteStop(t.travellog, tripId, stop.id)).rejects.toThrow(TripDayHasItemsError);
    expect(await listStops(t.travellog, tripId)).toHaveLength(1);
  });
});

describe('reorderStop', () => {
  it('moving the last stop to the front updates the trip’s recomputed start date', async () => {
    const stopA = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    const stopB = await createStop(t.travellog, tripId, {
      placeId: placeBId,
      arriveDate: '2026-09-02',
      departDate: '2026-09-04',
    });

    await reorderStop(t.travellog, tripId, stopB.id, 0);

    const stops = await listStops(t.travellog, tripId);
    expect(stops.map((s) => s.id)).toEqual([stopB.id, stopA.id]);

    const trip = await getTrip();
    expect(trip.startDate).toBe('2026-09-02'); // stopB is now first
    expect(trip.endDate).toBe('2026-09-01'); // stopA is now last
  });

  it('a no-op reorder (already in place) leaves order unchanged', async () => {
    const stopA = await createStop(t.travellog, tripId, {
      placeId: placeAId,
      arriveDate: '2026-08-31',
      departDate: '2026-09-01',
    });
    const stopB = await createStop(t.travellog, tripId, {
      placeId: placeBId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-02',
    });
    await reorderStop(t.travellog, tripId, stopA.id, 0);
    const stops = await listStops(t.travellog, tripId);
    expect(stops.map((s) => s.id)).toEqual([stopA.id, stopB.id]);
  });
});
