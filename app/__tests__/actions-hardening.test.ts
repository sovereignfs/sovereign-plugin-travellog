/**
 * Action-layer hardening: client-supplied storage keys are only accepted
 * from the caller's own area, malformed inputs come back as `fail(...)`
 * values (never a throw or a leaked driver message), and deletes remove
 * the storage objects their rows pointed at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../_db/__tests__/test-db';
import { fakeOpen, fakeRegisterTables, fakeSeal } from '../_db/__tests__/crypto-mock';
import * as schema from '../_db/schema';
import { createPlace } from '../_lib/places';
import { createVisit } from '../_lib/visits';

const harness = vi.hoisted(() => ({
  currentUser: null as { id: string; tenantId: string } | null,
  dbClient: null as unknown,
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
    crypto: { seal: fakeSeal, open: fakeOpen, registerTables: fakeRegisterTables },
    env: { get: vi.fn(async () => null) },
    storage: {
      getSignedUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
      delete: vi.fn(async (key: string) => {
        harness.deleteCalls.push(key);
      }),
    },
  },
}));

import * as actions from '../actions';

const user1 = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;
let placeId: string;

beforeEach(async () => {
  t = await createTestDb();
  harness.dbClient = t.db;
  harness.currentUser = { id: user1.userId, tenantId: user1.tenantId };
  harness.deleteCalls = [];
  const place = await createPlace(t.travellog, user1, { name: 'Belém Tower', source: 'manual' });
  placeId = place.id;
});

afterEach(() => {
  t.close();
});

const baseVisit = () => ({
  placeId,
  happenedAt: Date.now(),
  tzIana: 'Europe/Lisbon',
  tzOffsetMinutes: 60,
  source: 'manual' as const,
});

describe('storage-key ownership', () => {
  it('createVisitAction rejects a photo key from another user’s area, or another area entirely', async () => {
    for (const storageKey of [
      'visits/user-2/abc',
      'imports/user-1/export.zip',
      'attachments/user-1/abc',
      '../etc',
    ]) {
      const result = await actions.createVisitAction({
        ...baseVisit(),
        photos: [{ storageKey, source: 'upload' }],
      });
      expect(result.ok).toBe(false);
    }
    expect(await t.db.select().from(schema.visits)).toEqual([]);
  });

  it('createAttachmentAction rejects a key outside attachments/<me>/', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    const result = await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'other',
      title: 'x',
      storageKey: 'visits/user-1/abc',
    });
    expect(result.ok).toBe(false);
    expect(await t.db.select().from(schema.attachments)).toEqual([]);
  });
});

describe('input validation returns failures, never throws', () => {
  it('createStopAction with malformed dates', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    const result = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: 'abc',
      departDate: 'zzz',
    });
    expect(result).toMatchObject({ ok: false });
    expect(await t.db.select().from(schema.tripDays)).toEqual([]);
  });

  it('createStopAction with an absurd range', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    const result = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-01-01',
      departDate: '9999-12-31',
    });
    expect(result.ok).toBe(false);
    expect(await t.db.select().from(schema.tripDays)).toEqual([]);
  });

  it('createStopAction with a vanished place is a friendly failure, not a raw FK message', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    const result = await actions.createStopAction(trip.trip.id, {
      placeId: 'nope',
      arriveDate: '2026-01-01',
      departDate: '2026-01-02',
    });
    expect(result).toEqual({ ok: false, error: 'That place no longer exists — pick it again.' });
  });

  it('createVisitAction rejects a far-future instant, a bad offset, a foreign source, and oversized text', async () => {
    expect((await actions.createVisitAction({ ...baseVisit(), happenedAt: 1e18 })).ok).toBe(false);
    expect((await actions.createVisitAction({ ...baseVisit(), tzOffsetMinutes: 5000 })).ok).toBe(
      false,
    );
    expect(
      (
        await actions.createVisitAction({
          ...baseVisit(),
          source: 'import:swarm' as unknown as 'manual',
        })
      ).ok,
    ).toBe(false);
    expect((await actions.createVisitAction({ ...baseVisit(), note: 'x'.repeat(6000) })).ok).toBe(
      false,
    );
    expect(
      (
        await actions.createVisitAction({
          ...baseVisit(),
          companions: 'Sam' as unknown as string[],
        })
      ).ok,
    ).toBe(false);
    expect(await t.db.select().from(schema.visits)).toEqual([]);
  });

  it('itinerary items reject a malformed planned time and an unknown attachment kind is refused', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    const stop = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-01',
    });
    if (!stop.ok) throw new Error('setup');
    const [day] = await t.db.select().from(schema.tripDays);
    if (!day) throw new Error('setup');
    const item = await actions.createItineraryItemAction(day.id, { placeId, plannedTime: '9:00' });
    expect(item.ok).toBe(false);
    const attachment = await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'weird' as never,
      title: 'x',
      storageKey: 'attachments/user-1/abc',
    });
    expect(attachment.ok).toBe(false);
  });

  it('reorder actions reject a NaN target index', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    const stop = await actions.createStopAction(trip.trip.id, {
      placeId,
      arriveDate: '2026-06-01',
      departDate: '2026-06-01',
    });
    if (!stop.ok) throw new Error('setup');
    expect((await actions.reorderStopAction(trip.trip.id, stop.stop.id, Number.NaN)).ok).toBe(
      false,
    );
  });

  it('getTripModeAction tolerates a NaN instant', async () => {
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    expect(await actions.getTripModeAction(trip.trip.id, Number.NaN, 'UTC')).toBeNull();
  });
});

describe('deletes remove storage objects', () => {
  it('deleteVisitAction removes the photos; deleteTripAction removes every attachment', async () => {
    const visit = await createVisit(t.travellog, user1, {
      ...baseVisit(),
      photos: [{ storageKey: 'visits/user-1/photo', source: 'upload' }],
    });
    expect(await actions.deleteVisitAction(visit.id)).toEqual({
      ok: true,
      message: 'Check-in deleted.',
    });
    expect(harness.deleteCalls).toEqual(['visits/user-1/photo']);

    harness.deleteCalls = [];
    const trip = await actions.createTripAction('Trip');
    if (!trip.ok) throw new Error('setup');
    await actions.createAttachmentAction({
      tripId: trip.trip.id,
      kind: 'other',
      title: 'A',
      storageKey: 'attachments/user-1/a',
    });
    expect(await actions.deleteTripAction(trip.trip.id)).toEqual({
      ok: true,
      message: 'Trip deleted.',
    });
    expect(harness.deleteCalls).toEqual(['attachments/user-1/a']);
    expect(await t.db.select().from(schema.trips)).toEqual([]);
  });
});

describe('import cancel/resume', () => {
  it('cancelImportAction only touches the caller’s own job', async () => {
    const { createImportJob } = await import('../_lib/import-jobs');
    const job = await createImportJob(t.travellog, user1, 'imports/user-1/x.zip');
    harness.currentUser = { id: 'user-2', tenantId: 'tenant-1' };
    expect(await actions.cancelImportAction(job.id)).toEqual({
      ok: false,
      error: 'Import not found.',
    });
    harness.currentUser = { id: user1.userId, tenantId: user1.tenantId };
    expect(await actions.cancelImportAction(job.id)).toEqual({
      ok: true,
      message: 'Stopping the import…',
    });
    expect((await actions.getLatestImportJobAction())?.status).toBe('cancelled');
  });
});
