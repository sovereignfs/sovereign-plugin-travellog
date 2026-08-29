import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOpen, fakeRegisterTables, fakeSeal } from '../../_db/__tests__/crypto-mock';

// `_lib/visits.ts`/`queries.ts` call `sdk.crypto.seal()`/`open()` directly
// (T.24) — see `crypto-mock.ts`'s own header comment for why a real
// (fake-envelope, not passthrough) mock matters here.
vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    crypto: { seal: fakeSeal, open: fakeOpen, registerTables: fakeRegisterTables },
  },
}));

import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { addDaysToDateKey, todayDateKey } from '../dates';
import { createItineraryItem } from '../itinerary-items';
import { createPlace } from '../places';
import { createStop, listTripDays } from '../stops';
import { createTrip, updateTrip } from '../trips';
import { createVisit } from '../visits';
import {
  getTripsOverview,
  getVisitDetail,
  getVisitTimelinePage,
  listRecentPlaces,
  listTripCards,
  listTripsForPicker,
  listWorkspaceDays,
  listWorkspaceStops,
  VISIT_TIMELINE_PAGE_SIZE,
} from '../queries';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
const otherUserSameTenant = { tenantId: 'tenant-1', userId: 'user-2' };

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

describe('getVisitTimelinePage', () => {
  it('is reverse-chronological', async () => {
    const earlier = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 25),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    const later = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 27),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items.map((i) => i.id)).toEqual([later.id, earlier.id]);
  });

  it('has no next cursor when the page is smaller than the page size', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates via a (happenedAt, id) cursor with no gaps or duplicates across pages', async () => {
    // Two visits sharing the exact same millisecond timestamp — the id
    // tie-breaker is what a plain happenedAt-only cursor would get wrong.
    const sameInstant = Date.UTC(2026, 7, 27, 12, 0, 0);
    const created = [];
    for (let i = 0; i < VISIT_TIMELINE_PAGE_SIZE + 5; i++) {
      created.push(
        await createVisit(t.travellog, actor, {
          placeId,
          happenedAt: i < 2 ? sameInstant : sameInstant - i * 1000,
          tzIana: 'Europe/Lisbon',
          tzOffsetMinutes: 60,
          source: 'manual',
        }),
      );
    }

    const firstPage = await getVisitTimelinePage(t.travellog, actor);
    expect(firstPage.items).toHaveLength(VISIT_TIMELINE_PAGE_SIZE);
    const cursor = firstPage.nextCursor;
    if (!cursor) throw new Error('expected a next cursor');

    const secondPage = await getVisitTimelinePage(t.travellog, actor, cursor);
    expect(secondPage.items.length).toBeGreaterThan(0);

    const firstIds = new Set(firstPage.items.map((i) => i.id));
    const overlap = secondPage.items.filter((i) => firstIds.has(i.id));
    expect(overlap).toHaveLength(0);

    const totalSeen = firstPage.items.length + secondPage.items.length;
    expect(totalSeen).toBeLessThanOrEqual(created.length);
  });

  it('only returns the calling user’s own visits, even within the same tenant', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items).toHaveLength(1);
  });

  it('includes the place name/category and a note excerpt', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: 'A short note',
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items[0]).toMatchObject({ placeName: 'Belém Tower', noteExcerpt: 'A short note' });
  });

  it('surfaces the first photo by position, not insertion order', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      photos: [
        { storageKey: 'first.jpg', source: 'upload' },
        { storageKey: 'second.jpg', source: 'upload' },
      ],
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items[0]?.firstPhotoStorageKey).toBe('first.jpg');
  });
});

describe('getVisitDetail', () => {
  it('reading someone else’s visit is impossible — same tenant, different user', async () => {
    const theirs = await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect(await getVisitDetail(t.travellog, actor, theirs.id)).toBeNull();
    expect(await getVisitDetail(t.travellog, otherUserSameTenant, theirs.id)).not.toBeNull();
  });

  it('returns null for a non-existent visit — not an error', async () => {
    expect(await getVisitDetail(t.travellog, actor, 'no-such-visit')).toBeNull();
  });

  it('returns full detail: place, companions, ordered photos', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: 'Full note text',
      companions: ['Tom Kelly'],
      source: 'manual',
      photos: [
        { storageKey: 'a.jpg', source: 'upload' },
        { storageKey: 'b.jpg', source: 'upload' },
      ],
    });

    const detail = await getVisitDetail(t.travellog, actor, visit.id);
    expect(detail).toMatchObject({
      note: 'Full note text',
      companions: ['Tom Kelly'],
      place: { name: 'Belém Tower' },
    });
    expect(detail?.photos.map((p) => p.storageKey)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('placeVisitCount (T.9, CONCEPT.md per-place visit counts) counts every visit the caller logged at that place, including this one', async () => {
    const first = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now() - 1000,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    expect((await getVisitDetail(t.travellog, actor, first.id))?.placeVisitCount).toBe(1);

    const second = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    // Both visits at the same place now report the full count, not just "so far."
    expect((await getVisitDetail(t.travellog, actor, first.id))?.placeVisitCount).toBe(2);
    expect((await getVisitDetail(t.travellog, actor, second.id))?.placeVisitCount).toBe(2);
  });

  it('placeVisitCount is scoped to the caller — a same-tenant user’s visits to the same place never count toward another user’s total', async () => {
    const mine = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect((await getVisitDetail(t.travellog, actor, mine.id))?.placeVisitCount).toBe(1);
  });
});

describe('getTripsOverview (T.13, payload 1)', () => {
  it('returns zeroed counts and no next trip when the caller has nothing at all', async () => {
    const overview = await getTripsOverview(t.travellog, actor, '2026-06-01');
    expect(overview).toEqual({
      tripCounts: { planning: 0, upcoming: 0, ongoing: 0, completed: 0 },
      uniquePlaceCount: 0,
      uniqueCountryCount: 0,
      totalCheckins: 0,
      nextTrip: null,
    });
  });

  it('tallies trips into all four computed statuses', async () => {
    await createTrip(t.travellog, actor, 'No stops yet'); // planning
    const upcoming = await createTrip(t.travellog, actor, 'Upcoming trip');
    await createStop(t.travellog, upcoming.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    const ongoing = await createTrip(t.travellog, actor, 'Ongoing trip');
    await createStop(t.travellog, ongoing.id, { placeId, arriveDate: '2026-05-30', departDate: '2026-06-02' });
    const completed = await createTrip(t.travellog, actor, 'Completed trip');
    await createStop(t.travellog, completed.id, { placeId, arriveDate: '2026-05-01', departDate: '2026-05-03' });

    const overview = await getTripsOverview(t.travellog, actor, '2026-06-01');
    expect(overview.tripCounts).toEqual({ planning: 1, upcoming: 1, ongoing: 1, completed: 1 });
  });

  it('counts unique places/countries/check-ins from visits, not trip stops', async () => {
    const now = Date.now();
    await t.db.insert(schema.places).values({
      id: 'place-2',
      tenantId: actor.tenantId,
      name: 'Torre de Belém',
      country: 'Portugal',
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(schema.places).values({
      id: 'place-3',
      tenantId: actor.tenantId,
      name: 'No-country place',
      country: null,
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    // placeId itself has no country set by default — give it one for this test.
    await t.db.update(schema.places).set({ country: 'Portugal' }).where(eq(schema.places.id, placeId));

    await createVisit(t.travellog, actor, { placeId, happenedAt: now, tzIana: 'UTC', tzOffsetMinutes: 0, source: 'manual' });
    await createVisit(t.travellog, actor, { placeId: 'place-2', happenedAt: now, tzIana: 'UTC', tzOffsetMinutes: 0, source: 'manual' });
    await createVisit(t.travellog, actor, { placeId: 'place-3', happenedAt: now, tzIana: 'UTC', tzOffsetMinutes: 0, source: 'manual' });
    // A second visit to the same place — must not double-count uniquePlaceCount.
    await createVisit(t.travellog, actor, { placeId, happenedAt: now, tzIana: 'UTC', tzOffsetMinutes: 0, source: 'manual' });

    const overview = await getTripsOverview(t.travellog, actor, '2026-06-01');
    expect(overview.totalCheckins).toBe(4);
    expect(overview.uniquePlaceCount).toBe(3);
    expect(overview.uniqueCountryCount).toBe(1); // "Portugal" only — the null-country place doesn't count
  });

  it('surfaces the soonest upcoming trip, not just any upcoming trip', async () => {
    const farther = await createTrip(t.travellog, actor, 'Later trip');
    await createStop(t.travellog, farther.id, { placeId, arriveDate: '2026-08-01', departDate: '2026-08-03' });
    const sooner = await createTrip(t.travellog, actor, 'Sooner trip');
    await createStop(t.travellog, sooner.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });

    const overview = await getTripsOverview(t.travellog, actor, '2026-06-01');
    expect(overview.nextTrip).toEqual({ id: sooner.id, name: 'Sooner trip', daysUntil: 9 });
  });

  it('scopes everything to the caller — another user’s trips/visits never count', async () => {
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    const theirTrip = await createTrip(t.travellog, otherActor, 'Not mine');
    await createStop(t.travellog, theirTrip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    await createVisit(t.travellog, otherActor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });

    const overview = await getTripsOverview(t.travellog, actor, '2026-06-01');
    expect(overview.tripCounts).toEqual({ planning: 0, upcoming: 0, ongoing: 0, completed: 0 });
    expect(overview.totalCheckins).toBe(0);
  });
});

describe('listTripCards (T.13, payload 2)', () => {
  it('returns an empty array when the caller has no trips', async () => {
    expect(await listTripCards(t.travellog, actor)).toEqual([]);
  });

  it('includes a trip with no stops yet, with null dates and no destination summary', async () => {
    await createTrip(t.travellog, actor, 'Someday trip');
    const [card] = await listTripCards(t.travellog, actor);
    expect(card).toMatchObject({
      name: 'Someday trip',
      status: 'planning',
      startDate: null,
      endDate: null,
      stopCount: 0,
      dayCount: 0,
      destinationSummary: null,
      companions: [],
    });
  });

  it('carries companions on the card payload (T.14’s detail column reads this, not a second fetch)', async () => {
    const trip = await createTrip(t.travellog, actor, 'Reunion trip');
    await updateTrip(t.travellog, trip.id, { companions: ['Sam', 'Alex'] });
    const [card] = await listTripCards(t.travellog, actor);
    expect(card?.companions).toEqual(['Sam', 'Alex']);
  });

  it('summarizes the destination as the first stop’s place, plus a count of the rest', async () => {
    const now = Date.now();
    await t.db.insert(schema.places).values({
      id: 'place-2',
      tenantId: actor.tenantId,
      name: 'Porto',
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await createStop(t.travellog, trip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    await createStop(t.travellog, trip.id, { placeId: 'place-2', arriveDate: '2026-06-12', departDate: '2026-06-14' });

    const [card] = await listTripCards(t.travellog, actor);
    expect(card?.destinationSummary).toBe('Belém Tower +1');
    expect(card?.stopCount).toBe(2);
    // trip_days are unique per (stop_id, date), not (trip_id, date) — the
    // shared handover date (06-12) gets one row per stop, not one shared
    // row, so this is 3 + 3 = 6, not 5.
    expect(card?.dayCount).toBe(6);
  });

  it('a single-stop trip has no "+N" suffix', async () => {
    const trip = await createTrip(t.travellog, actor, 'Weekend trip');
    await createStop(t.travellog, trip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    const [card] = await listTripCards(t.travellog, actor);
    expect(card?.destinationSummary).toBe('Belém Tower');
  });

  it('scopes to the caller — another user’s trips never appear', async () => {
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    await createTrip(t.travellog, otherActor, 'Not mine');
    expect(await listTripCards(t.travellog, actor)).toEqual([]);
  });
});

describe('listTripsForPicker (T.15, payload 6)', () => {
  it('returns an empty array when the caller has no trips', async () => {
    expect(await listTripsForPicker(t.travellog, actor)).toEqual([]);
  });

  it('includes planning and upcoming trips, with a stop count', async () => {
    const planning = await createTrip(t.travellog, actor, 'Someday trip');
    const upcoming = await createTrip(t.travellog, actor, 'Berlin Design Week');
    await createStop(t.travellog, upcoming.id, { placeId, arriveDate: '2999-01-01', departDate: '2999-01-03' });

    const entries = await listTripsForPicker(t.travellog, actor);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === planning.id)).toMatchObject({
      name: 'Someday trip',
      status: 'planning',
      stopCount: 0,
    });
    expect(entries.find((e) => e.id === upcoming.id)).toMatchObject({
      name: 'Berlin Design Week',
      status: 'upcoming',
      startDate: '2999-01-01',
      endDate: '2999-01-03',
      stopCount: 1,
    });
  });

  it('excludes ongoing and completed trips', async () => {
    const ongoing = await createTrip(t.travellog, actor, 'Ongoing trip');
    const todayKey = todayDateKey();
    await createStop(t.travellog, ongoing.id, {
      placeId,
      arriveDate: addDaysToDateKey(todayKey, -1),
      departDate: addDaysToDateKey(todayKey, 1),
    });

    const completed = await createTrip(t.travellog, actor, 'Completed trip');
    await createStop(t.travellog, completed.id, { placeId, arriveDate: '2020-01-01', departDate: '2020-01-03' });

    expect(await listTripsForPicker(t.travellog, actor)).toEqual([]);
  });

  it('scopes to the caller — another user’s trips never appear', async () => {
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    await createTrip(t.travellog, otherActor, 'Not mine');
    expect(await listTripsForPicker(t.travellog, actor)).toEqual([]);
  });
});

describe('listWorkspaceStops (T.15, payload 7)', () => {
  it('returns an empty array for a trip with no stops', async () => {
    const trip = await createTrip(t.travellog, actor, 'Someday trip');
    expect(await listWorkspaceStops(t.travellog, actor, trip.id)).toEqual([]);
  });

  it('returns stops in position order, with place names', async () => {
    const now = Date.now();
    await t.db.insert(schema.places).values({
      id: 'place-2',
      tenantId: actor.tenantId,
      name: 'Porto',
      source: 'manual',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    await createStop(t.travellog, trip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    await createStop(t.travellog, trip.id, { placeId: 'place-2', arriveDate: '2026-06-12', departDate: '2026-06-14' });

    const stops = await listWorkspaceStops(t.travellog, actor, trip.id);
    expect(stops.map((s) => s.placeName)).toEqual(['Belém Tower', 'Porto']);
    expect(stops[0]).toMatchObject({ arriveDate: '2026-06-10', departDate: '2026-06-12' });
  });

  it('another user’s trip never appears, even by a guessed tripId', async () => {
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    const trip = await createTrip(t.travellog, otherActor, 'Not mine');
    await createStop(t.travellog, trip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    expect(await listWorkspaceStops(t.travellog, actor, trip.id)).toEqual([]);
  });
});

describe('listWorkspaceDays (T.16, payload 7’s day list)', () => {
  it('returns an empty array for a trip with no stops', async () => {
    const trip = await createTrip(t.travellog, actor, 'Someday trip');
    expect(await listWorkspaceDays(t.travellog, actor, trip.id)).toEqual([]);
  });

  it('returns one day per date in a stop’s range, empty of items, in date order', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });

    const days = await listWorkspaceDays(t.travellog, actor, trip.id);
    expect(days.map((d) => d.date)).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
    expect(days.every((d) => d.stopId === stop.id)).toBe(true);
    expect(days.every((d) => d.items.length === 0)).toBe(true);
  });

  it('nests itinerary items in position order, with place names for place-backed items', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-10',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a trip day');

    await createItineraryItem(t.travellog, day.id, trip.id, { title: 'Free time' });
    await createItineraryItem(t.travellog, day.id, trip.id, {
      placeId,
      plannedTime: '09:00',
      isFixed: true,
      notes: 'Bring water',
    });

    const days = await listWorkspaceDays(t.travellog, actor, trip.id);
    expect(days).toHaveLength(1);
    const [resultDay] = days;
    if (!resultDay) throw new Error('expected a day');
    expect(resultDay.items).toHaveLength(2);
    expect(resultDay.items[0]).toMatchObject({ title: 'Free time', placeId: null, placeName: null });
    expect(resultDay.items[1]).toMatchObject({
      placeId,
      placeName: 'Belém Tower',
      plannedTime: '09:00',
      isFixed: true,
      notes: 'Bring water',
    });
  });

  it('another user’s trip never appears, even by a guessed tripId', async () => {
    const otherActor = { tenantId: 'tenant-1', userId: 'user-2' };
    const trip = await createTrip(t.travellog, otherActor, 'Not mine');
    await createStop(t.travellog, trip.id, { placeId, arriveDate: '2026-06-10', departDate: '2026-06-12' });
    expect(await listWorkspaceDays(t.travellog, actor, trip.id)).toEqual([]);
  });
});

describe('listRecentPlaces (T.21)', () => {
  it('is empty with no check-in history', async () => {
    expect(await listRecentPlaces(t.travellog, actor)).toEqual([]);
  });

  it('orders by most recently visited', async () => {
    const porto = await createPlace(t.travellog, actor, { name: 'Porto', source: 'manual' });
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 25),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    await createVisit(t.travellog, actor, {
      placeId: porto.id,
      happenedAt: Date.UTC(2026, 7, 27),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const recent = await listRecentPlaces(t.travellog, actor);
    expect(recent.map((p) => p.name)).toEqual(['Porto', 'Belém Tower']);
  });

  it('dedupes repeat visits to the same place, keeping only its most recent position', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 20),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    const porto = await createPlace(t.travellog, actor, { name: 'Porto', source: 'manual' });
    await createVisit(t.travellog, actor, {
      placeId: porto.id,
      happenedAt: Date.UTC(2026, 7, 25),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    // Re-visits the first place, most recently of all three.
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 27),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const recent = await listRecentPlaces(t.travellog, actor);
    expect(recent.map((p) => p.name)).toEqual(['Belém Tower', 'Porto']);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      const place = await createPlace(t.travellog, actor, { name: `Place ${String(i)}`, source: 'manual' });
      await createVisit(t.travellog, actor, {
        placeId: place.id,
        happenedAt: Date.UTC(2026, 7, i + 1),
        tzIana: 'Europe/Lisbon',
        tzOffsetMinutes: 60,
        source: 'manual',
      });
    }

    expect(await listRecentPlaces(t.travellog, actor, 3)).toHaveLength(3);
  });

  it('scopes to the caller — another user’s check-in history never leaks in', async () => {
    await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 25),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect(await listRecentPlaces(t.travellog, actor)).toEqual([]);
  });

  it('carries coordinates through for the offline check-in queue payload', async () => {
    const geocoded = await createPlace(t.travellog, actor, {
      name: 'Torre de Belém',
      source: 'manual',
      lat: 38.691586,
      lng: -9.2159288,
    });
    await createVisit(t.travellog, actor, {
      placeId: geocoded.id,
      happenedAt: Date.UTC(2026, 7, 25),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const [recent] = await listRecentPlaces(t.travellog, actor);
    expect(recent).toMatchObject({ lat: 38.691586, lng: -9.2159288 });
  });
});
