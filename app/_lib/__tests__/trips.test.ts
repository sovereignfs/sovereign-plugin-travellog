import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createTrip, deleteTrip, updateTrip } from '../trips';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

describe('createTrip', () => {
  it('creates a trip with just a name — no date range', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    expect(trip.name).toBe('Portugal 2026');
    expect(trip.startDate).toBeNull();
    expect(trip.endDate).toBeNull();
    expect(trip.ownerId).toBe(actor.userId);
    expect(trip.tenantId).toBe(actor.tenantId);
    expect(trip.companions).toBeNull();
  });
});

describe('updateTrip', () => {
  it('updates name, timezone, and companions independently', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');

    const renamed = await updateTrip(t.travellog, trip.id, { name: 'Portugal & Spain 2026' });
    expect(renamed.name).toBe('Portugal & Spain 2026');
    expect(renamed.timezone).toBeNull();

    const withTz = await updateTrip(t.travellog, trip.id, { timezone: 'Europe/Lisbon' });
    expect(withTz.timezone).toBe('Europe/Lisbon');
    expect(withTz.name).toBe('Portugal & Spain 2026'); // untouched by the previous patch

    const withCompanions = await updateTrip(t.travellog, trip.id, {
      companions: ['Alex', 'Sam'],
    });
    expect(withCompanions.companions).toBe(JSON.stringify(['Alex', 'Sam']));

    const clearedCompanions = await updateTrip(t.travellog, trip.id, { companions: [] });
    expect(clearedCompanions.companions).toBeNull();
  });

  it('never writes startDate/endDate — those are stop-derived only', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const patched = await updateTrip(t.travellog, trip.id, { name: 'Renamed' });
    expect(patched.startDate).toBeNull();
    expect(patched.endDate).toBeNull();
  });
});

describe('deleteTrip', () => {
  async function seedTripWithItinerary(): Promise<{ tripId: string; visitId: string }> {
    const now = Date.now();
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await t.db.insert(schema.places).values({
      id: 'place-1',
      tenantId: actor.tenantId,
      name: 'Belém Tower',
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(schema.stops).values({
      id: 'stop-1',
      tripId: trip.id,
      placeId: 'place-1',
      arriveDate: '2026-09-01',
      departDate: '2026-09-02',
      position: 1024,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(schema.tripDays).values({
      id: 'day-1',
      stopId: 'stop-1',
      tripId: trip.id,
      date: '2026-09-01',
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(schema.itineraryItems).values({
      id: 'item-1',
      tripDayId: 'day-1',
      tripId: trip.id,
      placeId: 'place-1',
      position: 1024,
      isFixed: 0,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(schema.visits).values({
      id: 'visit-1',
      tenantId: actor.tenantId,
      userId: actor.userId,
      placeId: 'place-1',
      happenedAt: now,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      tripId: trip.id,
      linkSource: 'manual',
      createdAt: now,
      updatedAt: now,
    });
    return { tripId: trip.id, visitId: 'visit-1' };
  }

  it('deletes a bare trip with no stops', async () => {
    const trip = await createTrip(t.travellog, actor, 'Empty trip');
    await deleteTrip(t.travellog, trip.id);
    expect(await t.db.select().from(schema.trips)).toHaveLength(0);
  });

  it('cascades through a full itinerary that a plain DELETE would be blocked by', async () => {
    const { tripId } = await seedTripWithItinerary();

    await deleteTrip(t.travellog, tripId);

    expect(await t.db.select().from(schema.trips)).toHaveLength(0);
    expect(await t.db.select().from(schema.stops)).toHaveLength(0);
    expect(await t.db.select().from(schema.tripDays)).toHaveLength(0);
    expect(await t.db.select().from(schema.itineraryItems)).toHaveLength(0);
  });

  it('unlinks (never deletes) a visit that was linked to the trip, clearing linkSource too', async () => {
    const { tripId, visitId } = await seedTripWithItinerary();

    await deleteTrip(t.travellog, tripId);

    const [visit] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
    expect(visit).toBeDefined();
    expect(visit?.tripId).toBeNull();
    expect(visit?.linkSource).toBeNull();
  });
});
