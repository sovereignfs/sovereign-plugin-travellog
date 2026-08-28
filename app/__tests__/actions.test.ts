/**
 * Server-action authorization + behavior tests (T.4 review checklist):
 * every mutating action denies a non-owner without mutating anything, an
 * unauthenticated call is rejected, and a visit's timezone data round-trips
 * through the action layer unchanged. Runs against the real generated
 * migrations on an ephemeral libsql DB with the SDK mocked to impersonate
 * switchable users — same pattern as `sovereign-plugin-kanban`'s
 * `app/__tests__/actions.test.ts`. `fetch` is stubbed too, so
 * `searchPlacesAction` (which resolves the merged place provider,
 * including the OSM adapter) never makes a real network call.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../_db/__tests__/test-db';
import * as schema from '../_db/schema';
import { createPlace } from '../_lib/places';
import { createVisit } from '../_lib/visits';

const harness = vi.hoisted(() => ({
  currentUser: null as { id: string; tenantId: string } | null,
  dbClient: null as unknown,
  /** Keyed by storageKey — a missing entry makes `getSignedUrl` throw, matching the real host. */
  signedUrlsByKey: new Map<string, string>(),
  deleteCalls: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    auth: {
      requireSession: vi.fn(async () => {
        if (!harness.currentUser) throw new Error('Not authenticated');
        return { user: harness.currentUser };
      }),
    },
    db: { getClient: vi.fn(async () => harness.dbClient) },
    env: { get: vi.fn(async () => null) },
    storage: {
      getSignedUrl: vi.fn(async (key: string) => {
        const url = harness.signedUrlsByKey.get(key);
        if (!url) throw new Error(`Storage object not found for key "${key}".`);
        return url;
      }),
      delete: vi.fn(async (key: string) => {
        harness.deleteCalls.push(key);
      }),
    },
  },
}));

import * as actions from '../actions';

const user1 = { tenantId: 'tenant-1', userId: 'user-1' };
const user2 = { tenantId: 'tenant-1', userId: 'user-2' };

let t: TestDb;
let placeId: string;

beforeEach(async () => {
  t = await createTestDb();
  harness.dbClient = t.db;
  harness.currentUser = { id: user1.userId, tenantId: user1.tenantId };
  harness.signedUrlsByKey.clear();
  harness.deleteCalls = [];
  const place = await createPlace(t.travellog, user1, { name: 'Belém Tower', source: 'manual' });
  placeId = place.id;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
});

afterEach(() => {
  t.close();
  vi.unstubAllGlobals();
});

describe('createVisitAction', () => {
  it('creates a visit for the authenticated user', async () => {
    const result = await actions.createVisitAction({
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    expect(result).toEqual({ ok: true, message: 'Checked in.' });

    const rows = await t.db.select().from(schema.visits);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(user1.userId);
  });

  it('rejects an invalid timezone as an expected failure, not a throw', async () => {
    const result = await actions.createVisitAction({
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Not/A_Real_Zone',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(result.ok).toBe(false);
    expect(await t.db.select().from(schema.visits)).toHaveLength(0);
  });

  it('rejects a non-finite happenedAt', async () => {
    const result = await actions.createVisitAction({
      placeId,
      happenedAt: Number.NaN,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    expect(result.ok).toBe(false);
  });

  it('throws when called with no session — not reachable from normal UI', async () => {
    harness.currentUser = null;
    await expect(
      actions.createVisitAction({
        placeId,
        happenedAt: Date.now(),
        tzIana: 'Europe/Lisbon',
        tzOffsetMinutes: 60,
        source: 'manual',
      }),
    ).rejects.toThrow();
  });
});

describe('updateVisitAction / deleteVisitAction — ownership', () => {
  it('denies updating another user’s visit without mutating it, reading as "not found"', async () => {
    const theirs = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: 'original',
      source: 'manual',
    });

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    const result = await actions.updateVisitAction(theirs.id, { note: 'hijacked' });
    expect(result).toEqual({ ok: false, error: 'Check-in not found.' });

    const [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, theirs.id));
    expect(row?.note).toBe('original');
  });

  it('denies deleting another user’s visit — it still exists after', async () => {
    const theirs = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    const result = await actions.deleteVisitAction(theirs.id);
    expect(result).toEqual({ ok: false, error: 'Check-in not found.' });
    expect(await t.db.select().from(schema.visits).where(eq(schema.visits.id, theirs.id))).toHaveLength(1);
  });

  it('the owner can update and delete their own visit', async () => {
    const mine = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect(await actions.updateVisitAction(mine.id, { note: 'mine now' })).toEqual({
      ok: true,
      message: 'Check-in updated.',
    });
    expect(await actions.deleteVisitAction(mine.id)).toEqual({
      ok: true,
      message: 'Check-in deleted.',
    });
    expect(await t.db.select().from(schema.visits).where(eq(schema.visits.id, mine.id))).toHaveLength(0);
  });
});

describe('createPlaceAction', () => {
  it('always creates the place as source "manual", ignoring any client-supplied source', async () => {
    // Cast past the type system deliberately — CreatePlaceActionInput has no
    // `source` field at all; this proves the server doesn't trust one even
    // from a hand-crafted call bypassing that type.
    const result = await actions.createPlaceAction({
      name: 'New Café',
      source: 'import',
    } as unknown as actions.CreatePlaceActionInput);

    expect(result.ok).toBe(true);
    const [row] = await t.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'New Café'));
    expect(row?.source).toBe('manual');
  });

  it('rejects a blank name', async () => {
    const result = await actions.createPlaceAction({ name: '   ' });
    expect(result).toEqual({ ok: false, error: 'Place name is required.' });
  });
});

describe('searchPlacesAction', () => {
  it('requires a session even for a read', async () => {
    harness.currentUser = null;
    await expect(actions.searchPlacesAction('anything')).rejects.toThrow();
  });

  it('returns local matches without a real network call (fetch is stubbed)', async () => {
    const results = await actions.searchPlacesAction('Belém');
    expect(results.some((r) => r.name === 'Belém Tower')).toBe(true);
  });
});

describe('reverseGeocodePlaceAction', () => {
  it('requires a session even for a read', async () => {
    harness.currentUser = null;
    await expect(actions.reverseGeocodePlaceAction(38.6916, -9.2159)).rejects.toThrow();
  });

  it('resolves a candidate from the OSM adapter (fetch stubbed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          lat: '38.6916',
          lon: '-9.2159',
          display_name: 'Belém Tower, Avenida Brasília, Lisbon, Portugal',
        }),
      ),
    );
    const result = await actions.reverseGeocodePlaceAction(38.6916, -9.2159);
    expect(result).toMatchObject({ name: 'Belém Tower', lat: 38.6916, lng: -9.2159 });
  });

  it('returns null, never throws, when nothing resolves (a normal outcome, not an error)', async () => {
    const result = await actions.reverseGeocodePlaceAction(0, 0);
    expect(result).toBeNull();
  });
});

describe('getVisitDetailAction', () => {
  it('denies a non-owner, reading as not-found', async () => {
    const visitId = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    }).then((v) => v.id);

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    const result = await actions.getVisitDetailAction(visitId);
    expect(result).toBeNull();
  });

  it('resolves each photo to a signed URL, never the raw storage key', async () => {
    harness.signedUrlsByKey.set('photos/ok.jpg', 'https://cdn.example/signed/ok');
    const visit = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      photos: [{ storageKey: 'photos/ok.jpg', source: 'upload' }],
    });

    const result = await actions.getVisitDetailAction(visit.id);
    expect(result?.photos).toEqual([
      { id: expect.any(String), url: 'https://cdn.example/signed/ok', position: expect.any(Number) },
    ]);
  });

  it('drops a photo whose storage object is gone instead of throwing (a real bug caught live: T.6)', async () => {
    harness.signedUrlsByKey.set('photos/ok.jpg', 'https://cdn.example/signed/ok');
    // 'photos/missing.jpg' is deliberately never registered — getSignedUrl throws for it.
    const visit = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      photos: [
        { storageKey: 'photos/missing.jpg', source: 'upload' },
        { storageKey: 'photos/ok.jpg', source: 'upload' },
      ],
    });

    const result = await actions.getVisitDetailAction(visit.id);
    expect(result).not.toBeNull();
    expect(result?.photos).toHaveLength(1);
    expect(result?.photos[0]?.url).toBe('https://cdn.example/signed/ok');
  });
});

// ---------------------------------------------------------------------------
// T.11 — Trips, stops, itinerary items, attachments

describe('createTripAction / updateTripAction / deleteTripAction', () => {
  it('creates a trip for the authenticated user', async () => {
    const result = await actions.createTripAction('Portugal 2026');
    expect(result.ok).toBe(true);
    expect(await t.db.select().from(schema.trips)).toHaveLength(1);
  });

  it('rejects a blank name', async () => {
    const result = await actions.createTripAction('   ');
    expect(result).toEqual({ ok: false, error: 'Trip name is required.' });
  });

  it('denies updating another user’s trip without mutating it, reading as "not found"', async () => {
    const created = await actions.createTripAction('Portugal 2026');
    if (!created.ok) throw new Error('setup failed');

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    const result = await actions.updateTripAction(created.trip.id, { name: 'Hijacked' });
    expect(result).toEqual({ ok: false, error: 'Trip not found.' });

    const [row] = await t.db.select().from(schema.trips).where(eq(schema.trips.id, created.trip.id));
    expect(row?.name).toBe('Portugal 2026');
  });

  it('denies deleting another user’s trip — it still exists after', async () => {
    const created = await actions.createTripAction('Portugal 2026');
    if (!created.ok) throw new Error('setup failed');

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    const result = await actions.deleteTripAction(created.trip.id);
    expect(result).toEqual({ ok: false, error: 'Trip not found.' });
    expect(await t.db.select().from(schema.trips).where(eq(schema.trips.id, created.trip.id))).toHaveLength(1);
  });

  it('the owner can update and delete their own trip', async () => {
    const created = await actions.createTripAction('Portugal 2026');
    if (!created.ok) throw new Error('setup failed');

    expect(await actions.updateTripAction(created.trip.id, { name: 'Renamed' })).toEqual({
      ok: true,
      message: 'Trip updated.',
    });
    expect(await actions.deleteTripAction(created.trip.id)).toEqual({
      ok: true,
      message: 'Trip deleted.',
    });
    expect(await t.db.select().from(schema.trips)).toHaveLength(0);
  });
});

describe('stop actions', () => {
  async function createOwnedTrip(): Promise<string> {
    const created = await actions.createTripAction('Portugal 2026');
    if (!created.ok) throw new Error('setup failed');
    return created.trip.id;
  }

  it('denies creating a stop on another user’s trip', async () => {
    const tripId = await createOwnedTrip();
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };

    const result = await actions.createStopAction(tripId, {
      placeId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-02',
    });
    expect(result).toEqual({ ok: false, error: 'Trip not found.' });
    expect(await t.db.select().from(schema.stops)).toHaveLength(0);
  });

  it('the owner can create a stop, which recomputes the trip’s dates', async () => {
    const tripId = await createOwnedTrip();
    const result = await actions.createStopAction(tripId, {
      placeId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-03',
    });
    expect(result.ok).toBe(true);

    const [trip] = await t.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    expect(trip?.startDate).toBe('2026-09-01');
    expect(trip?.endDate).toBe('2026-09-03');
  });

  it('denies updating/deleting/reordering a stop that belongs to another user’s trip', async () => {
    const tripId = await createOwnedTrip();
    const created = await actions.createStopAction(tripId, {
      placeId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-02',
    });
    if (!created.ok) throw new Error('setup failed');
    const stopId = created.stop.id;

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    expect(await actions.updateStopAction(tripId, stopId, { placeId })).toEqual({
      ok: false,
      error: 'Trip not found.',
    });
    expect(await actions.deleteStopAction(tripId, stopId)).toEqual({
      ok: false,
      error: 'Trip not found.',
    });
    expect(await actions.reorderStopAction(tripId, stopId, 0)).toEqual({
      ok: false,
      error: 'Trip not found.',
    });
  });

  it('blocks updating a stop’s dates when it would drop a day with itinerary items — surfaced as a plain ActionResult, not a throw', async () => {
    const tripId = await createOwnedTrip();
    const created = await actions.createStopAction(tripId, {
      placeId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-03',
    });
    if (!created.ok) throw new Error('setup failed');
    const [lastDay] = await t.db
      .select()
      .from(schema.tripDays)
      .where(eq(schema.tripDays.date, '2026-09-03'));
    if (!lastDay) throw new Error('expected the last day to exist');
    await t.db.insert(schema.itineraryItems).values({
      id: 'item-1',
      tripDayId: lastDay.id,
      tripId,
      placeId,
      position: 1024,
      isFixed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = await actions.updateStopAction(tripId, created.stop.id, {
      departDate: '2026-09-01',
    });
    expect(result.ok).toBe(false);
  });

  it('the owner can reorder stops', async () => {
    const tripId = await createOwnedTrip();
    const stopA = await actions.createStopAction(tripId, {
      placeId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-02',
    });
    const stopB = await actions.createStopAction(tripId, {
      placeId,
      arriveDate: '2026-09-02',
      departDate: '2026-09-03',
    });
    if (!stopA.ok || !stopB.ok) throw new Error('setup failed');

    expect(await actions.reorderStopAction(tripId, stopB.stop.id, 0)).toEqual({
      ok: true,
      message: 'Stop reordered.',
    });
    const stops = await t.db.select().from(schema.stops).orderBy(schema.stops.position);
    expect(stops.map((s) => s.id)).toEqual([stopB.stop.id, stopA.stop.id]);
  });
});

describe('itinerary item actions', () => {
  async function createOwnedTripDay(): Promise<{ tripId: string; tripDayId: string }> {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    const stop = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-09-01',
      departDate: '2026-09-01',
    });
    if (!stop.ok) throw new Error('setup failed');
    const [day] = await t.db.select().from(schema.tripDays).where(eq(schema.tripDays.stopId, stop.stop.id));
    if (!day) throw new Error('expected a trip day');
    return { tripId: trip.trip.id, tripDayId: day.id };
  }

  it('denies creating an item on a day belonging to another user’s trip', async () => {
    const { tripDayId } = await createOwnedTripDay();
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };

    const result = await actions.createItineraryItemAction(tripDayId, { placeId });
    expect(result).toEqual({ ok: false, error: 'Day not found.' });
    expect(await t.db.select().from(schema.itineraryItems)).toHaveLength(0);
  });

  it('the owner can create, update, reorder, and delete an item', async () => {
    const { tripDayId } = await createOwnedTripDay();

    const created = await actions.createItineraryItemAction(tripDayId, { placeId });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');

    expect(
      await actions.updateItineraryItemAction(created.item.id, {
        plannedTime: '19:00',
        isFixed: true,
      }),
    ).toEqual({ ok: true, message: 'Item updated.' });

    const second = await actions.createItineraryItemAction(tripDayId, { title: 'Dinner' });
    if (!second.ok) throw new Error('setup failed');
    expect(await actions.reorderItineraryItemAction(tripDayId, second.item.id, 0)).toEqual({
      ok: true,
      message: 'Item reordered.',
    });

    expect(await actions.deleteItineraryItemAction(created.item.id)).toEqual({
      ok: true,
      message: 'Item removed.',
    });
    expect(await t.db.select().from(schema.itineraryItems)).toHaveLength(1);
  });

  it('rejects marking an item fixed with no plannedTime, as a plain ActionResult', async () => {
    const { tripDayId } = await createOwnedTripDay();
    const created = await actions.createItineraryItemAction(tripDayId, { placeId, isFixed: true });
    expect(created.ok).toBe(false);
  });

  it('denies updating/deleting/reordering another user’s item', async () => {
    const { tripDayId } = await createOwnedTripDay();
    const created = await actions.createItineraryItemAction(tripDayId, { placeId });
    if (!created.ok) throw new Error('setup failed');

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    expect(await actions.updateItineraryItemAction(created.item.id, { title: 'Hijacked' })).toEqual({
      ok: false,
      error: 'Itinerary item not found.',
    });
    expect(await actions.deleteItineraryItemAction(created.item.id)).toEqual({
      ok: false,
      error: 'Itinerary item not found.',
    });
    // Denied at the day-ownership check first (reorderItineraryItemAction
    // checks the day before the item) — still a correct denial, just a
    // different not-found message than update/delete's item-first check.
    expect(await actions.reorderItineraryItemAction(tripDayId, created.item.id, 0)).toEqual({
      ok: false,
      error: 'Day not found.',
    });
  });
});

describe('attachment actions', () => {
  it('denies creating an attachment on another user’s trip', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };

    const result = await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'booking',
      title: 'Flight',
      storageKey: 'attachments/flight.pdf',
    });
    expect(result).toEqual({ ok: false, error: 'Trip not found.' });
    expect(await t.db.select().from(schema.attachments)).toHaveLength(0);
  });

  it('rejects a target with neither tripId nor tripDayId — the XOR validator surfaced as ActionResult', async () => {
    const result = await actions.createAttachmentAction({
      kind: 'other',
      title: 'Untargeted',
      storageKey: 'attachments/x.pdf',
    });
    expect(result.ok).toBe(false);
  });

  it('the owner can create a trip-level attachment and later delete it, which also deletes the storage object', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');

    expect(
      await actions.createAttachmentAction({
        tripId: trip.trip.id,
        kind: 'receipt',
        title: 'Hotel receipt',
        storageKey: 'attachments/hotel.pdf',
      }),
    ).toEqual({ ok: true, message: 'Attachment added.' });

    const [row] = await t.db.select().from(schema.attachments);
    if (!row) throw new Error('expected the attachment row to exist');

    expect(await actions.deleteAttachmentAction(row.id)).toEqual({
      ok: true,
      message: 'Attachment deleted.',
    });
    expect(await t.db.select().from(schema.attachments)).toHaveLength(0);
    expect(harness.deleteCalls).toEqual(['attachments/hotel.pdf']);
  });

  it('denies deleting another user’s attachment, leaving the storage object untouched', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'receipt',
      title: 'Hotel receipt',
      storageKey: 'attachments/hotel.pdf',
    });
    const [row] = await t.db.select().from(schema.attachments);
    if (!row) throw new Error('expected the attachment row to exist');

    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    expect(await actions.deleteAttachmentAction(row.id)).toEqual({
      ok: false,
      error: 'Attachment not found.',
    });
    expect(harness.deleteCalls).toHaveLength(0);
  });
});

describe('getTripAttachmentsAction (T.17)', () => {
  it('returns an empty array for another user’s trip, never leaking that it exists', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };

    expect(await actions.getTripAttachmentsAction(trip.trip.id)).toEqual([]);
  });

  it('resolves each attachment to a signed URL, oldest first', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'booking',
      title: 'Flight confirmation',
      storageKey: 'attachments/flight.pdf',
    });
    await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'receipt',
      title: 'Hotel receipt',
      storageKey: 'attachments/hotel.pdf',
    });
    harness.signedUrlsByKey.set('attachments/flight.pdf', 'https://signed.example/flight.pdf');
    harness.signedUrlsByKey.set('attachments/hotel.pdf', 'https://signed.example/hotel.pdf');

    const attachments = await actions.getTripAttachmentsAction(trip.trip.id);
    expect(attachments).toMatchObject([
      { kind: 'booking', title: 'Flight confirmation', url: 'https://signed.example/flight.pdf' },
      { kind: 'receipt', title: 'Hotel receipt', url: 'https://signed.example/hotel.pdf' },
    ]);
  });

  it('drops an attachment whose storage object is gone instead of failing the whole list', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'other',
      title: 'Never actually uploaded',
      storageKey: 'attachments/missing.pdf',
    });
    // Deliberately never registered in `signedUrlsByKey` — `getSignedUrl` throws for it.

    expect(await actions.getTripAttachmentsAction(trip.trip.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T.12 — auto-link engine, through the action layer

describe('createVisitAction — auto-link integration (T.12)', () => {
  it('auto-links a new check-in to a trip whose stop covers its local calendar date', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    const stop = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
    });
    if (!stop.ok) throw new Error('setup failed');

    const result = await actions.createVisitAction({
      placeId,
      happenedAt: Date.parse('2026-06-10T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(result.ok).toBe(true);

    const [visit] = await t.db.select().from(schema.visits);
    expect(visit?.tripId).toBe(trip.trip.id);
    expect(visit?.linkSource).toBe('auto');
  });

  it('leaves a check-in unlinked when no trip covers its date — not an error', async () => {
    const result = await actions.createVisitAction({
      placeId,
      happenedAt: Date.parse('2026-06-10T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(result.ok).toBe(true);
    const [visit] = await t.db.select().from(schema.visits);
    expect(visit?.tripId).toBeNull();
    expect(visit?.linkSource).toBeNull();
  });
});

describe('setVisitTripLinkAction (T.12 manual override / unlink)', () => {
  it('denies linking another user’s visit', async () => {
    const theirs = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };

    const result = await actions.setVisitTripLinkAction(theirs.id, null);
    expect(result).toEqual({ ok: false, error: 'Check-in not found.' });
  });

  it('denies linking the caller’s own visit to another user’s trip', async () => {
    const mine = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };
    const theirTrip = await actions.createTripAction('Someone else’s trip');
    harness.currentUser = { id: user1.userId, tenantId: user1.tenantId };
    if (!theirTrip.ok) throw new Error('setup failed');

    const result = await actions.setVisitTripLinkAction(mine.id, theirTrip.trip.id);
    expect(result).toEqual({ ok: false, error: 'Trip not found.' });
  });

  it('the owner can link and unlink their own visit; a manual link survives a recompute', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    const visit = await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect(await actions.setVisitTripLinkAction(visit.id, trip.trip.id)).toEqual({
      ok: true,
      message: 'Check-in linked to trip.',
    });
    let [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id));
    expect(row?.tripId).toBe(trip.trip.id);
    expect(row?.linkSource).toBe('manual');

    // Recompute must never touch a manually-linked visit.
    await actions.recomputeMyAutoLinksAction();
    [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id));
    expect(row?.tripId).toBe(trip.trip.id);
    expect(row?.linkSource).toBe('manual');

    // Unlink — also manual, and also sticky.
    expect(await actions.setVisitTripLinkAction(visit.id, null)).toEqual({
      ok: true,
      message: 'Check-in unlinked.',
    });
    [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id));
    expect(row?.tripId).toBeNull();
    expect(row?.linkSource).toBe('manual');
  });
});

describe('recomputeMyAutoLinksAction', () => {
  it('requires a session', async () => {
    harness.currentUser = null;
    await expect(actions.recomputeMyAutoLinksAction()).rejects.toThrow();
  });

  it('reports how many check-ins changed', async () => {
    expect(await actions.recomputeMyAutoLinksAction()).toEqual({
      ok: true,
      message: 'Check-in links are already up to date.',
    });

    await createVisit(t.travellog, user1, {
      placeId,
      happenedAt: Date.parse('2026-06-10T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    // Insert the stop directly — bypassing ./stops.ts's own auto-trigger —
    // so this test exercises the standalone action, not that integration.
    await t.db.insert(schema.stops).values({
      id: 'stop-1',
      tripId: trip.trip.id,
      placeId,
      arriveDate: '2026-06-08',
      departDate: '2026-06-12',
      position: 1024,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await t.db
      .update(schema.trips)
      .set({ startDate: '2026-06-08', endDate: '2026-06-12' })
      .where(eq(schema.trips.id, trip.trip.id));

    expect(await actions.recomputeMyAutoLinksAction()).toEqual({
      ok: true,
      message: 'Updated 1 check-in link.',
    });
  });
});

describe('getTripModeAction (T.19)', () => {
  it('returns null for another user’s trip, never leaking that it exists', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    harness.currentUser = { id: user2.userId, tenantId: user2.tenantId };

    expect(
      await actions.getTripModeAction(trip.trip.id, Date.parse('2026-06-10T12:00:00Z'), 'UTC'),
    ).toBeNull();
  });

  it('returns null when no stop covers today — outside the trip’s real date range', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    const stop = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });
    if (!stop.ok) throw new Error('setup failed');

    expect(
      await actions.getTripModeAction(trip.trip.id, Date.parse('2026-06-20T12:00:00Z'), 'UTC'),
    ).toBeNull();
  });

  it('returns null for an invalid timezone rather than throwing', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');

    expect(
      await actions.getTripModeAction(trip.trip.id, Date.parse('2026-06-10T12:00:00Z'), 'Not/A_Zone'),
    ).toBeNull();
  });

  it('the owner gets today’s active stop, its items, and the next one', async () => {
    const trip = await actions.createTripAction('Portugal 2026');
    if (!trip.ok) throw new Error('setup failed');
    const stop = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    if (!stop.ok) throw new Error('setup failed');
    const [day] = await t.db.select().from(schema.tripDays).where(eq(schema.tripDays.stopId, stop.stop.id));
    if (!day) throw new Error('expected a trip day');

    await actions.createItineraryItemAction(day.id, { placeId, plannedTime: '09:00' });
    await actions.createItineraryItemAction(day.id, { placeId, plannedTime: '18:00' });

    const result = await actions.getTripModeAction(
      trip.trip.id,
      Date.parse('2026-06-10T10:00:00Z'), // between the two items
      'UTC',
    );
    expect(result?.stop.stopId).toBe(stop.stop.id);
    expect(result?.today.items).toHaveLength(2);
    expect(result?.today.nextItem?.plannedTime).toBe('18:00');
    expect(result?.today.countdownMinutes).toBe(480);
  });
});
