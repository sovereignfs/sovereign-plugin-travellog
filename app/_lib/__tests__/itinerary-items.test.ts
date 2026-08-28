import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createTrip } from '../trips';
import { createStop, listTripDays } from '../stops';
import {
  createItineraryItem,
  deleteItineraryItem,
  listItineraryItems,
  reorderItineraryItem,
  updateItineraryItem,
} from '../itinerary-items';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;
let tripId: string;
let tripDayId: string;
let placeId: string;

beforeEach(async () => {
  t = await createTestDb();
  const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
  tripId = trip.id;

  const now = Date.now();
  placeId = 'place-1';
  await t.db.insert(schema.places).values({
    id: placeId,
    tenantId: actor.tenantId,
    name: 'Belém Tower',
    source: 'manual',
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  });

  const stop = await createStop(t.travellog, tripId, {
    placeId,
    arriveDate: '2026-09-01',
    departDate: '2026-09-02',
  });
  const [day] = await listTripDays(t.travellog, stop.id);
  if (!day) throw new Error('expected a trip day');
  tripDayId = day.id;
});

afterEach(() => {
  t.close();
});

describe('createItineraryItem', () => {
  it('creates a place-backed item', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, { placeId });
    expect(item.placeId).toBe(placeId);
    expect(item.title).toBeNull();
    expect(item.isFixed).toBe(0);
  });

  it('creates a title-only item with no resolved place', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, {
      title: 'Wander the old town',
    });
    expect(item.placeId).toBeNull();
    expect(item.title).toBe('Wander the old town');
  });

  it('rejects an item with neither a place nor a title', async () => {
    await expect(createItineraryItem(t.travellog, tripDayId, tripId, {})).rejects.toThrow();
  });

  it('rejects isFixed without a plannedTime', async () => {
    await expect(
      createItineraryItem(t.travellog, tripDayId, tripId, { placeId, isFixed: true }),
    ).rejects.toThrow();
  });

  it('accepts isFixed alongside a plannedTime', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, {
      placeId,
      plannedTime: '19:00',
      isFixed: true,
    });
    expect(item.isFixed).toBe(1);
    expect(item.plannedTime).toBe('19:00');
  });

  it('appends items in creation order', async () => {
    const first = await createItineraryItem(t.travellog, tripDayId, tripId, { placeId });
    const second = await createItineraryItem(t.travellog, tripDayId, tripId, { title: 'Lunch' });
    const items = await listItineraryItems(t.travellog, tripDayId);
    expect(items.map((i) => i.id)).toEqual([first.id, second.id]);
  });
});

describe('updateItineraryItem', () => {
  it('setting isFixed true on an item that already has a plannedTime succeeds', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, {
      placeId,
      plannedTime: '09:00',
    });
    const updated = await updateItineraryItem(t.travellog, item.id, { isFixed: true });
    expect(updated.isFixed).toBe(1);
  });

  it('setting isFixed true with no existing or patched plannedTime fails', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, { placeId });
    await expect(updateItineraryItem(t.travellog, item.id, { isFixed: true })).rejects.toThrow();
  });

  it('clearing plannedTime on an already-fixed item without also clearing isFixed fails', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, {
      placeId,
      plannedTime: '09:00',
      isFixed: true,
    });
    await expect(
      updateItineraryItem(t.travellog, item.id, { plannedTime: null }),
    ).rejects.toThrow();
  });

  it('clearing plannedTime and isFixed together on the same patch succeeds', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, {
      placeId,
      plannedTime: '09:00',
      isFixed: true,
    });
    const updated = await updateItineraryItem(t.travellog, item.id, {
      plannedTime: null,
      isFixed: false,
    });
    expect(updated.plannedTime).toBeNull();
    expect(updated.isFixed).toBe(0);
  });

  it('rejects clearing both place and title, leaving the item with neither', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, { placeId });
    await expect(
      updateItineraryItem(t.travellog, item.id, { placeId: null }),
    ).rejects.toThrow();
  });
});

describe('deleteItineraryItem', () => {
  it('removes the item', async () => {
    const item = await createItineraryItem(t.travellog, tripDayId, tripId, { placeId });
    await deleteItineraryItem(t.travellog, item.id);
    expect(await listItineraryItems(t.travellog, tripDayId)).toHaveLength(0);
  });
});

describe('reorderItineraryItem', () => {
  it('moves an item earlier in the day', async () => {
    const a = await createItineraryItem(t.travellog, tripDayId, tripId, { title: 'Breakfast' });
    const b = await createItineraryItem(t.travellog, tripDayId, tripId, { title: 'Museum' });
    const c = await createItineraryItem(t.travellog, tripDayId, tripId, { title: 'Dinner' });

    await reorderItineraryItem(t.travellog, tripDayId, c.id, 0);

    const items = await listItineraryItems(t.travellog, tripDayId);
    expect(items.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
  });
});
