import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createStop, updateStop } from '../stops';
import { createTrip } from '../trips';
import { computeAutoLinkForVisit, pickBestTrip, recomputeAutoLinksForActor } from '../auto-link';

describe('pickBestTrip (T.12 review checklist: narrower-range-wins)', () => {
  it('returns null when there are no candidate trips', () => {
    expect(pickBestTrip('2026-06-10', [])).toBeNull();
  });

  it('returns null when no trip’s range contains the date', () => {
    const trips = [{ tripId: 'trip-1', startDate: '2026-06-01', endDate: '2026-06-05' }];
    expect(pickBestTrip('2026-06-10', trips)).toBeNull();
  });

  it('returns the single matching trip', () => {
    const trips = [{ tripId: 'trip-1', startDate: '2026-06-01', endDate: '2026-06-15' }];
    expect(pickBestTrip('2026-06-10', trips)).toBe('trip-1');
  });

  it('matches on the exact start and end date boundaries', () => {
    const trips = [{ tripId: 'trip-1', startDate: '2026-06-10', endDate: '2026-06-15' }];
    expect(pickBestTrip('2026-06-10', trips)).toBe('trip-1');
    expect(pickBestTrip('2026-06-15', trips)).toBe('trip-1');
  });

  it('picks the narrower of two overlapping trips (a work trip and a personal weekend sharing dates)', () => {
    const trips = [
      { tripId: 'work-trip', startDate: '2026-06-01', endDate: '2026-06-20' },
      { tripId: 'personal-weekend', startDate: '2026-06-10', endDate: '2026-06-12' },
    ];
    expect(pickBestTrip('2026-06-11', trips)).toBe('personal-weekend');
  });

  it('order of the input array never changes the result', () => {
    const trips = [
      { tripId: 'personal-weekend', startDate: '2026-06-10', endDate: '2026-06-12' },
      { tripId: 'work-trip', startDate: '2026-06-01', endDate: '2026-06-20' },
    ];
    expect(pickBestTrip('2026-06-11', trips)).toBe('personal-weekend');
  });

  it('breaks a tied range width by the earlier start date', () => {
    const trips = [
      { tripId: 'trip-b', startDate: '2026-06-03', endDate: '2026-06-05' },
      { tripId: 'trip-a', startDate: '2026-06-01', endDate: '2026-06-03' },
    ];
    // Both are 2-day ranges (width 2) and both contain 2026-06-03 — trip-a starts earlier.
    expect(pickBestTrip('2026-06-03', trips)).toBe('trip-a');
  });

  it('breaks a tied range width and tied start date by the lower tripId — deterministic, not input-order-dependent', () => {
    const trips = [
      { tripId: 'trip-b', startDate: '2026-06-01', endDate: '2026-06-03' },
      { tripId: 'trip-a', startDate: '2026-06-01', endDate: '2026-06-03' },
    ];
    expect(pickBestTrip('2026-06-02', trips)).toBe('trip-a');
    expect(pickBestTrip('2026-06-02', [...trips].reverse())).toBe('trip-a');
  });
});

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

async function seedPlace(id: string): Promise<void> {
  const now = Date.now();
  await t.db.insert(schema.places).values({
    id,
    tenantId: actor.tenantId,
    name: `Place ${id}`,
    source: 'manual',
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  });
}

describe('computeAutoLinkForVisit', () => {
  it('returns null/null when no trip matches', async () => {
    const result = await computeAutoLinkForVisit(t.travellog, actor, {
      happenedAt: Date.parse('2026-06-10T12:00:00Z'),
      tzIana: 'UTC',
    });
    expect(result).toEqual({ tripId: null, linkSource: null });
  });

  it('links to a trip whose date range contains the visit’s local calendar date', async () => {
    await seedPlace('place-1');
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await createStop(t.travellog, trip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
    });

    // 11pm local in a positive-offset zone lands on the next UTC day —
    // this is exactly why the algorithm uses the *local* date, not the UTC one.
    const result = await computeAutoLinkForVisit(t.travellog, actor, {
      happenedAt: Date.parse('2026-06-10T23:00:00+02:00'), // 2026-06-10 local, 2026-06-10T21:00Z
      tzIana: 'Europe/Lisbon',
    });
    expect(result).toEqual({ tripId: trip.id, linkSource: 'auto' });
  });

  it('only considers the actor’s own trips, never another user’s', async () => {
    await seedPlace('place-1');
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    const theirTrip = await createTrip(t.travellog, otherActor, 'Someone else’s trip');
    await createStop(t.travellog, theirTrip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
    });

    const result = await computeAutoLinkForVisit(t.travellog, actor, {
      happenedAt: Date.parse('2026-06-10T12:00:00Z'),
      tzIana: 'UTC',
    });
    expect(result).toEqual({ tripId: null, linkSource: null });
  });
});

describe('recomputeAutoLinksForActor', () => {
  async function insertVisit(id: string, happenedAt: number, overrides: Partial<typeof schema.visits.$inferInsert> = {}) {
    const now = Date.now();
    await t.db.insert(schema.visits).values({
      id,
      tenantId: actor.tenantId,
      userId: actor.userId,
      placeId: 'place-1',
      happenedAt,
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  it('backfills a previously-unlinked visit automatically the moment a matching stop is created — no explicit recompute call needed (./stops.ts’s own integration)', async () => {
    await seedPlace('place-1');
    await insertVisit('visit-1', Date.parse('2026-06-10T12:00:00Z'));

    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await createStop(t.travellog, trip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
    });

    const [visit] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, 'visit-1'));
    expect(visit?.tripId).toBe(trip.id);
    expect(visit?.linkSource).toBe('auto');

    // Already up to date — an explicit recompute is a correct no-op, not a re-link.
    expect(await recomputeAutoLinksForActor(t.travellog, actor)).toBe(0);
  });

  it('recomputeAutoLinksForActor itself backfills when called directly (no stop mutation involved)', async () => {
    await seedPlace('place-1');
    await insertVisit('visit-1', Date.parse('2026-06-10T12:00:00Z'));
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    // Insert the stop's row directly, bypassing ./stops.ts entirely, so this
    // test exercises recomputeAutoLinksForActor in isolation, not the
    // createStop integration the test above already covers.
    const now = Date.now();
    await t.db.insert(schema.stops).values({
      id: 'stop-1',
      tripId: trip.id,
      placeId: 'place-1',
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
      position: 1024,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.update(schema.trips).set({ startDate: '2026-06-08', endDate: '2026-06-12' }).where(eq(schema.trips.id, trip.id));

    expect(await recomputeAutoLinksForActor(t.travellog, actor)).toBe(1);
    const [visit] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, 'visit-1'));
    expect(visit?.tripId).toBe(trip.id);
    expect(visit?.linkSource).toBe('auto');
  });

  it('unlinks an auto-linked visit that no longer matches after the trip’s dates shrink', async () => {
    await seedPlace('place-1');
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
    });
    await insertVisit('visit-1', Date.parse('2026-06-10T12:00:00Z'), {
      tripId: trip.id,
      linkSource: 'auto',
    });

    // Shrink the stop so 2026-06-10 falls outside the new range — this
    // alone should trigger the recompute (`./stops.ts`'s own integration),
    // no explicit `recomputeAutoLinksForActor` call needed here.
    await updateStop(t.travellog, trip.id, stop.id, { departDate: '2026-06-09' });

    const [visit] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, 'visit-1'));
    expect(visit?.tripId).toBeNull();
    expect(visit?.linkSource).toBeNull();
  });

  it('never touches a manually-linked visit, even if a narrower trip now matches better', async () => {
    await seedPlace('place-1');
    const wideTrip = await createTrip(t.travellog, actor, 'Wide trip');
    await createStop(t.travellog, wideTrip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-01',
      departDate: '2026-06-20',
    });
    await insertVisit('visit-1', Date.parse('2026-06-10T12:00:00Z'), {
      tripId: wideTrip.id,
      linkSource: 'manual',
    });

    const narrowTrip = await createTrip(t.travellog, actor, 'Narrow trip');
    await createStop(t.travellog, narrowTrip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });

    const changed = await recomputeAutoLinksForActor(t.travellog, actor);
    expect(changed).toBe(0);

    const [visit] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, 'visit-1'));
    expect(visit?.tripId).toBe(wideTrip.id);
    expect(visit?.linkSource).toBe('manual');
  });

  it('never touches a manually-unlinked visit ({tripId: null, linkSource: "manual"}), even if it would now match', async () => {
    await seedPlace('place-1');
    await insertVisit('visit-1', Date.parse('2026-06-10T12:00:00Z'), {
      tripId: null,
      linkSource: 'manual',
    });

    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await createStop(t.travellog, trip.id, {
      placeId: 'place-1',
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
    });

    const changed = await recomputeAutoLinksForActor(t.travellog, actor);
    expect(changed).toBe(0);

    const [visit] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, 'visit-1'));
    expect(visit?.tripId).toBeNull();
    expect(visit?.linkSource).toBe('manual');
  });

  it('reports 0 changed when nothing needs updating', async () => {
    await seedPlace('place-1');
    expect(await recomputeAutoLinksForActor(t.travellog, actor)).toBe(0);
  });
});
