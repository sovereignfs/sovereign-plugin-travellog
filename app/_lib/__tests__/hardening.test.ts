/**
 * Regression coverage for the review-driven hardening pass: every case here
 * was a real defect found by reading the code — each test names the
 * failure it guards against, and each was seen to fail against the
 * pre-fix code before landing.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOpen, fakeRegisterTables, fakeSeal } from '../../_db/__tests__/crypto-mock';

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    crypto: { seal: fakeSeal, open: fakeOpen, registerTables: fakeRegisterTables },
  },
}));

import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { enumerateDateKeys, MAX_STOP_DAYS } from '../dates';
import { sniffFileType, sniffRasterImageType } from '../file-type';
import {
  claimReminderForItem,
  createItineraryItem,
  ItineraryItemValidationError,
  moveItineraryItem,
  releaseReminderClaim,
  updateItineraryItem,
} from '../itinerary-items';
import { createAttachment } from '../attachments';
import { createPlace } from '../places';
import {
  createStop,
  deleteStop,
  listTripDays,
  StopOverlapError,
  stopRangesOverlap,
  StopValidationError,
  updateStop,
} from '../stops';
import { offsetMinutesAt, zonedTimeToUtcMs } from '../timezone';
import {
  resolveActiveStop,
  resolveNextItem,
  resolveTripModeToday,
  type TripModeItem,
} from '../trip-mode';
import { createTrip, deleteTrip } from '../trips';
import {
  isOwnStorageKey,
  isValidHappenedAt,
  isValidPlannedTime,
  isValidTzOffsetMinutes,
  normalizeCompanions,
} from '../validation';
import { createVisit, deleteVisit, updateVisit } from '../visits';
import { recomputeAutoLinksForActor } from '../auto-link';

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

describe('enumerateDateKeys — malformed and oversized ranges are rejected, never looped', () => {
  it('throws on a non-date key instead of spinning forever (the original runaway)', () => {
    expect(() => enumerateDateKeys('abc', 'zzz')).toThrow(/malformed/);
  });

  it('caps the range at MAX_STOP_DAYS', () => {
    expect(() => enumerateDateKeys('2026-01-01', '2999-12-31')).toThrow(/MAX_STOP_DAYS/);
    expect(enumerateDateKeys('2026-01-01', '2026-12-31')).toHaveLength(365);
    expect(MAX_STOP_DAYS).toBeGreaterThanOrEqual(366);
  });
});

describe('createStop / updateStop — date validation', () => {
  it('rejects a malformed date key as a StopValidationError, writing nothing', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    await expect(
      createStop(t.travellog, trip.id, { placeId, arriveDate: 'abc', departDate: 'zzz' }),
    ).rejects.toBeInstanceOf(StopValidationError);
    expect(await t.db.select().from(schema.stops)).toEqual([]);
  });

  it('rejects a range longer than MAX_STOP_DAYS', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    await expect(
      createStop(t.travellog, trip.id, {
        placeId,
        arriveDate: '2026-01-01',
        departDate: '2027-06-01',
      }),
    ).rejects.toBeInstanceOf(StopValidationError);
    expect(await t.db.select().from(schema.tripDays)).toEqual([]);
  });

  it('rejects a stop that overlaps a sibling, but allows a shared boundary day', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-03',
    });

    await expect(
      createStop(t.travellog, trip.id, {
        placeId,
        arriveDate: '2026-06-02',
        departDate: '2026-06-05',
      }),
    ).rejects.toBeInstanceOf(StopOverlapError);

    // Leave one place on the 3rd, arrive at the next on the 3rd — a travel day.
    const next = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-03',
      departDate: '2026-06-05',
    });
    expect(next.arriveDate).toBe('2026-06-03');

    // Editing the first stop into the second's range is rejected too.
    await expect(
      updateStop(t.travellog, trip.id, next.id, { arriveDate: '2026-06-02' }),
    ).rejects.toBeInstanceOf(StopOverlapError);
  });

  it('stopRangesOverlap is symmetric and boundary-exclusive', () => {
    const a = { arriveDate: '2026-06-01', departDate: '2026-06-03' };
    const b = { arriveDate: '2026-06-03', departDate: '2026-06-05' };
    const c = { arriveDate: '2026-06-02', departDate: '2026-06-02' };
    expect(stopRangesOverlap(a, b)).toBe(false);
    expect(stopRangesOverlap(b, a)).toBe(false);
    expect(stopRangesOverlap(a, c)).toBe(true);
    expect(stopRangesOverlap(c, a)).toBe(true);
  });

  it('the trip range is min(arrive)..max(depart) regardless of insertion order', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });
    await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-03',
    });
    const [row] = await t.db.select().from(schema.trips).where(eq(schema.trips.id, trip.id));
    expect(row).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-12' });
  });
});

describe('storage-key hand-back on deletes (the data layer never calls sdk.storage itself)', () => {
  it('deleteVisit returns every photo key whose row cascaded away', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
      photos: [
        { storageKey: 'visits/user-1/a', source: 'upload' },
        { storageKey: 'visits/user-1/b', source: 'upload' },
      ],
    });
    const result = await deleteVisit(t.travellog, visit.id);
    expect(result.photoStorageKeys.sort()).toEqual(['visits/user-1/a', 'visits/user-1/b']);
    expect(await t.db.select().from(schema.visitPhotos)).toEqual([]);
  });

  it('deleteStop returns its days’ attachment keys; deleteTrip returns trip-level and day-level keys', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-01',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a day');
    await createAttachment(t.travellog, actor, {
      tripDayId: day.id,
      kind: 'other',
      title: 'Day',
      storageKey: 'attachments/user-1/day',
    });
    await createAttachment(t.travellog, actor, {
      tripId: trip.id,
      kind: 'other',
      title: 'Trip',
      storageKey: 'attachments/user-1/trip',
    });

    const stopResult = await deleteStop(t.travellog, trip.id, stop.id);
    expect(stopResult.attachmentStorageKeys).toEqual(['attachments/user-1/day']);

    const tripResult = await deleteTrip(t.travellog, trip.id);
    expect(tripResult.attachmentStorageKeys).toEqual(['attachments/user-1/trip']);
    expect(await t.db.select().from(schema.attachments)).toEqual([]);
  });
});

describe('updateVisit — re-dating re-runs the auto-link', () => {
  it('moves the visit onto the trip its new date falls inside, and off it again', async () => {
    const trip = await createTrip(t.travellog, actor, 'June trip');
    await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });

    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.parse('2026-05-01T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(visit.tripId).toBeNull();

    const moved = await updateVisit(t.travellog, visit.id, {
      happenedAt: Date.parse('2026-06-11T12:00:00Z'),
    });
    expect(moved).toMatchObject({ tripId: trip.id, linkSource: 'auto' });

    const movedBack = await updateVisit(t.travellog, visit.id, {
      happenedAt: Date.parse('2026-05-01T12:00:00Z'),
    });
    expect(movedBack).toMatchObject({ tripId: null, linkSource: null });
  });

  it('never overrides a manual link decision', async () => {
    const trip = await createTrip(t.travellog, actor, 'June trip');
    await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-10',
      departDate: '2026-06-12',
    });
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.parse('2026-06-11T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    await t.db
      .update(schema.visits)
      .set({ tripId: null, linkSource: 'manual' })
      .where(eq(schema.visits.id, visit.id));

    const updated = await updateVisit(t.travellog, visit.id, {
      happenedAt: Date.parse('2026-06-10T12:00:00Z'),
    });
    expect(updated).toMatchObject({ tripId: null, linkSource: 'manual' });
  });
});

describe('recomputeAutoLinksForActor — bounded candidate set still reaches every visit that can change', () => {
  it('unlinks a visit whose trip shrank away from it, and links one inside the window', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-10',
    });
    const early = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.parse('2026-06-02T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(early.tripId).toBe(trip.id);

    // Shrinking the stop runs the recompute inside updateStop.
    await updateStop(t.travellog, trip.id, stop.id, { arriveDate: '2026-06-05' });
    const [afterShrink] = await t.db
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.id, early.id));
    expect(afterShrink).toMatchObject({ tripId: null, linkSource: null });

    // A far-away visit outside every window is never touched (and never read).
    const far = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.parse('2020-01-01T12:00:00Z'),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(await recomputeAutoLinksForActor(t.travellog, actor)).toBe(0);
    const [farRow] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, far.id));
    expect(farRow?.tripId).toBeNull();
  });
});

describe('itinerary items — planned time validation, reminder re-arm, move', () => {
  async function dayAndTrip() {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-02',
    });
    const days = await listTripDays(t.travellog, stop.id);
    const [day1, day2] = days;
    if (!day1 || !day2) throw new Error('expected two days');
    return { trip, day1, day2 };
  }

  it('rejects a non-"HH:mm" planned time (a plain string compare is only chronological for that shape)', async () => {
    const { trip, day1 } = await dayAndTrip();
    await expect(
      createItineraryItem(t.travellog, day1.id, trip.id, { placeId, plannedTime: '9:00' }),
    ).rejects.toBeInstanceOf(ItineraryItemValidationError);
  });

  it('changing the planned time clears a previous reminder claim; an unrelated edit keeps it', async () => {
    const { trip, day1 } = await dayAndTrip();
    const item = await createItineraryItem(t.travellog, day1.id, trip.id, {
      placeId,
      plannedTime: '10:00',
    });
    expect(await claimReminderForItem(t.travellog, item.id, 1000)).toBe(true);

    await updateItineraryItem(t.travellog, item.id, { notes: 'bring a hat' });
    const [kept] = await t.db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, item.id));
    expect(kept?.reminderSentAt).toBe(1000);

    await updateItineraryItem(t.travellog, item.id, { plannedTime: '18:00' });
    const [rearmed] = await t.db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, item.id));
    expect(rearmed?.reminderSentAt).toBeNull();
  });

  it('releaseReminderClaim only releases the claim it was given', async () => {
    const { trip, day1 } = await dayAndTrip();
    const item = await createItineraryItem(t.travellog, day1.id, trip.id, {
      placeId,
      plannedTime: '10:00',
    });
    await claimReminderForItem(t.travellog, item.id, 1000);
    await releaseReminderClaim(t.travellog, item.id, 999); // someone else's claim value — no-op
    const [still] = await t.db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, item.id));
    expect(still?.reminderSentAt).toBe(1000);
    await releaseReminderClaim(t.travellog, item.id, 1000);
    const [released] = await t.db
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, item.id));
    expect(released?.reminderSentAt).toBeNull();
  });

  it('moves an item to another day of the same trip, appended last, and refuses a day of another trip', async () => {
    const { trip, day1, day2 } = await dayAndTrip();
    const existing = await createItineraryItem(t.travellog, day2.id, trip.id, {
      title: 'Already there',
    });
    const item = await createItineraryItem(t.travellog, day1.id, trip.id, {
      placeId,
      plannedTime: '10:00',
    });

    const moved = await moveItineraryItem(t.travellog, item.id, day2.id);
    expect(moved.tripDayId).toBe(day2.id);
    expect(moved.position).toBeGreaterThan(existing.position);

    const other = await createTrip(t.travellog, actor, 'Other trip');
    const otherStop = await createStop(t.travellog, other.id, {
      placeId,
      arriveDate: '2026-07-01',
      departDate: '2026-07-01',
    });
    const [otherDay] = await listTripDays(t.travellog, otherStop.id);
    if (!otherDay) throw new Error('expected a day');
    await expect(moveItineraryItem(t.travellog, item.id, otherDay.id)).rejects.toBeInstanceOf(
      ItineraryItemValidationError,
    );
  });
});

describe('trip mode — "next" by time, DST-correct countdown, deterministic active stop', () => {
  const item = (id: string, plannedTime: string | null, position: number): TripModeItem => ({
    id,
    placeId: null,
    placeName: null,
    placeLat: null,
    placeLng: null,
    title: id,
    plannedTime,
    isFixed: false,
    notes: null,
    position,
  });

  it('picks the soonest timed item ahead, even when a later-timed item sits earlier by position', () => {
    const items = [
      item('dinner', '18:00', 1),
      item('museum', '10:00', 2),
      item('untimed', null, 3),
    ];
    const now = Date.parse('2026-06-10T08:45:00Z');
    const result = resolveNextItem(items, '2026-06-10', now, 'UTC');
    expect(result.nextItem?.id).toBe('museum');
    expect(result.countdownMinutes).toBe(75);
  });

  it('the countdown is a difference of instants — right across a spring-forward day', () => {
    // 2026-03-29 is the EU spring-forward date: 01:00 UTC the clocks jump 02:00 → 03:00.
    // At 01:30 local (00:30 UTC, still CET), an item at 04:00 local (02:00 UTC) is 90 real minutes away — not 150 wall-clock minutes.
    const now = Date.parse('2026-03-29T00:30:00Z');
    const result = resolveNextItem([item('x', '04:00', 1)], '2026-03-29', now, 'Europe/Berlin');
    expect(result.countdownMinutes).toBe(90);
  });

  it('zonedTimeToUtcMs / offsetMinutesAt agree with the zone on both sides of a transition', () => {
    expect(offsetMinutesAt(Date.parse('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(60);
    expect(offsetMinutesAt(Date.parse('2026-07-15T12:00:00Z'), 'Europe/Berlin')).toBe(120);
    expect(zonedTimeToUtcMs('2026-07-15', '14:00', 'Europe/Berlin')).toBe(
      Date.parse('2026-07-15T12:00:00Z'),
    );
    expect(zonedTimeToUtcMs('2026-01-15', '14:00', 'Asia/Kolkata')).toBe(
      Date.parse('2026-01-15T08:30:00Z'),
    );
  });

  it('on a shared boundary day the stop being arrived at wins', async () => {
    const trip = await createTrip(t.travellog, actor, 'Trip');
    const lisbon = await createPlace(t.travellog, actor, { name: 'Lisbon', source: 'manual' });
    const porto = await createPlace(t.travellog, actor, { name: 'Porto', source: 'manual' });
    await createStop(t.travellog, trip.id, {
      placeId: lisbon.id,
      arriveDate: '2026-06-01',
      departDate: '2026-06-03',
    });
    await createStop(t.travellog, trip.id, {
      placeId: porto.id,
      arriveDate: '2026-06-03',
      departDate: '2026-06-05',
    });

    const active = await resolveActiveStop(t.travellog, trip.id, '2026-06-03');
    expect(active?.placeName).toBe('Porto');
    const today = await resolveTripModeToday(
      t.travellog,
      active?.stopId ?? '',
      Date.parse('2026-06-03T12:00:00Z'),
      'UTC',
    );
    expect(today?.date).toBe('2026-06-03');
  });
});

describe('validation helpers', () => {
  it('isOwnStorageKey only accepts this user’s own area', () => {
    expect(isOwnStorageKey('visits/user-1/abc123', 'visits', 'user-1')).toBe(true);
    expect(isOwnStorageKey('visits/user-2/abc123', 'visits', 'user-1')).toBe(false);
    expect(isOwnStorageKey('attachments/user-1/abc', 'visits', 'user-1')).toBe(false);
    expect(isOwnStorageKey('imports/user-1/x.zip', 'visits', 'user-1')).toBe(false);
    expect(isOwnStorageKey('visits/user-1/../secret', 'visits', 'user-1')).toBe(false);
    expect(isOwnStorageKey(42, 'visits', 'user-1')).toBe(false);
  });

  it('happenedAt must be a plausible past-or-near-now instant', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    expect(isValidHappenedAt(now - 1000, now)).toBe(true);
    expect(isValidHappenedAt(now + 60 * 60 * 1000, now)).toBe(true); // clock skew tolerance
    expect(isValidHappenedAt(now + 3 * 24 * 60 * 60 * 1000, now)).toBe(false);
    expect(isValidHappenedAt(1e18, now)).toBe(false);
    expect(isValidHappenedAt(1_700_000_000, now)).toBe(false); // seconds, not ms
    expect(isValidHappenedAt(Number.NaN, now)).toBe(false);
  });

  it('planned time, tz offset, companions', () => {
    expect(isValidPlannedTime('09:05')).toBe(true);
    expect(isValidPlannedTime('9:05')).toBe(false);
    expect(isValidPlannedTime('24:00')).toBe(false);
    expect(isValidTzOffsetMinutes(-720)).toBe(true);
    expect(isValidTzOffsetMinutes(900)).toBe(false);
    expect(isValidTzOffsetMinutes(1.5)).toBe(false);
    expect(normalizeCompanions(undefined)).toEqual([]);
    expect(normalizeCompanions([' Sam ', 'Sam', '', 'Jo'])).toEqual(['Sam', 'Jo']);
    expect(normalizeCompanions('Sam')).toBeNull();
    expect(normalizeCompanions([1])).toBeNull();
  });
});

describe('file-type sniffing', () => {
  it('recognises the accepted formats by their bytes and nothing else', () => {
    expect(sniffFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffFileType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(sniffFileType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(sniffFileType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(
      sniffFileType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffFileType(new TextEncoder().encode('<!doctype html>'))).toBeNull();
    expect(sniffRasterImageType(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
  });
});
