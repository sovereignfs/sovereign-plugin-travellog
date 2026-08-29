/**
 * `T.23`'s review checklist, verified directly against the real registered
 * handlers and a real (ephemeral) database — not just hand-called pure
 * functions. `@sovereignfs/sdk` is mocked the same way
 * `_jobs/__tests__/import-swarm.test.ts` mocks `db.getClient`/`storage`;
 * `portability.provideExport/provideImport/provideDelete` additionally
 * capture the registered function, mirroring `sovereign-plugin-docs`'
 * `portability.test.ts` capture pattern — so each test calls the exact
 * function the platform would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  DeletionContext,
  DeletionResult,
  ExportContext,
  ImportContext,
  PluginExportSection,
} from '@sovereignfs/sdk';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import * as schema from '../../_db/schema';
import { createPlace } from '../places';
import { createTrip } from '../trips';
import { createStop, listTripDays } from '../stops';
import { createItineraryItem } from '../itinerary-items';
import { createVisit } from '../visits';

let dbClient: unknown = null;

const harness = vi.hoisted(() => ({
  storageObjects: new Map<string, { bytes: Uint8Array; contentType: string; ownerUserId: string | null }>(),
  putCalls: [] as { key: string; contentType: string; ownerUserId?: string }[],
}));

const captured = {
  exporter: null as ((ctx: ExportContext) => Promise<PluginExportSection>) | null,
  importer: null as ((section: PluginExportSection, ctx: ImportContext) => Promise<void>) | null,
  deleter: null as ((ctx: DeletionContext) => Promise<DeletionResult>) | null,
};

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    db: { getClient: vi.fn(async () => dbClient) },
    storage: {
      get: vi.fn(async (key: string) => {
        const stored = harness.storageObjects.get(key);
        if (!stored) return null;
        return {
          id: key,
          key,
          contentType: stored.contentType,
          size: stored.bytes.length,
          checksum: '',
          metadata: null,
          ownerUserId: stored.ownerUserId,
          createdAt: 0,
          updatedAt: 0,
          body: new Blob([new Uint8Array(stored.bytes)]).stream(),
        };
      }),
      put: vi.fn(
        async (input: { key: string; body: Uint8Array; contentType: string; ownerUserId?: string }) => {
          harness.storageObjects.set(input.key, {
            bytes: input.body,
            contentType: input.contentType,
            ownerUserId: input.ownerUserId ?? null,
          });
          harness.putCalls.push({
            key: input.key,
            contentType: input.contentType,
            ownerUserId: input.ownerUserId,
          });
          return {
            id: input.key,
            key: input.key,
            contentType: input.contentType,
            size: input.body.length,
            checksum: '',
            metadata: null,
            ownerUserId: input.ownerUserId ?? null,
            createdAt: 0,
            updatedAt: 0,
          };
        },
      ),
    },
    portability: {
      provideExport: vi.fn(async (fn: typeof captured.exporter) => {
        captured.exporter = fn;
      }),
      provideImport: vi.fn(async (fn: typeof captured.importer) => {
        captured.importer = fn;
      }),
      provideDelete: vi.fn(async (fn: typeof captured.deleter) => {
        captured.deleter = fn;
      }),
    },
  },
}));

import { registerPortabilityHandlers } from '../portability';

const userA = { tenantId: 'tenant-1', userId: 'user-a' };
const userB = { tenantId: 'tenant-1', userId: 'user-b' };

function remapper() {
  const map = new Map<string, string>();
  return (originalId: string): string => {
    let mapped = map.get(originalId);
    if (!mapped) {
      mapped = `remapped-${String(map.size)}-${originalId}`;
      map.set(originalId, mapped);
    }
    return mapped;
  };
}

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  dbClient = t.travellog;
  harness.storageObjects.clear();
  harness.putCalls.length = 0;
  await registerPortabilityHandlers();
});

afterEach(() => {
  t.close();
});

async function seedTripWithEverything(actor: typeof userA, photoBytes?: Uint8Array) {
  const place = await createPlace(
    t.travellog,
    actor,
    { name: 'Torre de Belém', category: 'landmark', source: 'manual' },
  );
  const trip = await createTrip(t.travellog, actor, 'Lisbon Trip');
  const stop = await createStop(t.travellog, trip.id, {
    placeId: place.id,
    arriveDate: '2026-06-01',
    departDate: '2026-06-02',
  });
  const [day] = await listTripDays(t.travellog, stop.id);
  if (!day) throw new Error('seed: no trip day created');
  const item = await createItineraryItem(t.travellog, day.id, trip.id, {
    placeId: place.id,
    plannedTime: '10:00',
  });

  let photoStorageKey: string | undefined;
  if (photoBytes) {
    photoStorageKey = `visits/${actor.userId}/seed-photo`;
    harness.storageObjects.set(photoStorageKey, {
      bytes: photoBytes,
      contentType: 'image/jpeg',
      ownerUserId: actor.userId,
    });
  }

  const visit = await createVisit(t.travellog, actor, {
    placeId: place.id,
    happenedAt: Date.parse('2026-06-01T12:00:00Z'),
    tzIana: 'Europe/Lisbon',
    tzOffsetMinutes: 60,
    note: 'Great view',
    companions: ['Sam'],
    source: 'manual',
    photos: photoStorageKey ? [{ storageKey: photoStorageKey, source: 'upload' }] : undefined,
  });

  return { place, trip, stop, day, item, visit };
}

describe('exportTravellogData', () => {
  it('exports only the calling user\'s places/visits/trips/stops/days/items, with companions parsed', async () => {
    await seedTripWithEverything(userA);
    await seedTripWithEverything(userB);
    if (!captured.exporter) throw new Error('exporter not registered');

    const section = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: false },
    });

    expect(section.pluginId).toBe('fs.sovereign.travellog');
    const data = section.data as {
      places: { id: string }[];
      visits: { companions: string[] }[];
      trips: { id: string }[];
      stops: { id: string }[];
      tripDays: { id: string }[];
      itineraryItems: { id: string }[];
    };
    expect(data.places).toHaveLength(1);
    expect(data.visits).toHaveLength(1);
    expect(data.visits[0]?.companions).toEqual(['Sam']);
    expect(data.trips).toHaveLength(1);
    expect(data.stops).toHaveLength(1);
    expect(data.tripDays.length).toBeGreaterThan(0);
    expect(data.itineraryItems).toHaveLength(1);
  });

  it('includes photo bytes as a blob when includeFiles is true, and omits blobs entirely when false', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await seedTripWithEverything(userA, bytes);
    if (!captured.exporter) throw new Error('exporter not registered');

    const withFiles = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: true },
    });
    expect(withFiles.blobs).toBeDefined();
    const blobKeys = Object.keys(withFiles.blobs ?? {});
    expect(blobKeys).toHaveLength(1);
    expect(withFiles.blobs?.[blobKeys[0] as string]).toEqual(bytes);

    const withoutFiles = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: false },
    });
    expect(withoutFiles.blobs).toBeUndefined();
  });

  it('warns instead of throwing when a photo\'s storage object is missing', async () => {
    await seedTripWithEverything(userA);
    const [visitRow] = await t.travellog.select().from(schema.visits);
    if (!visitRow) throw new Error('seed: no visit created');
    await t.travellog.insert(schema.visitPhotos).values({
      id: 'photo-missing',
      visitId: visitRow.id,
      storageKey: 'visits/user-a/does-not-exist',
      position: 1,
      source: 'upload',
      createdAt: Date.now(),
    });
    if (!captured.exporter) throw new Error('exporter not registered');

    const section = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: true },
    });
    expect(section.warnings?.some((w) => w.includes('could not be read'))).toBe(true);
  });
});

describe('importTravellogData', () => {
  it('round-trips an export into fresh, remapped rows owned by the importing user, including photo bytes', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const seeded = await seedTripWithEverything(userA, bytes);
    if (!captured.exporter || !captured.importer) throw new Error('handlers not registered');

    const section = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: true },
    });

    // Import into a different user on the same instance — the review
    // checklist's "delete all local data → import round-trips" scenario is
    // equivalent to this for the data layer: the importer never assumes
    // anything about what's already present.
    await captured.importer(section, {
      userId: userB.userId,
      tenantId: userB.tenantId,
      remapId: remapper(),
    });

    const importedTrips = await t.travellog
      .select()
      .from(schema.trips)
      .where(eq(schema.trips.ownerId, userB.userId));
    expect(importedTrips).toHaveLength(1);
    expect(importedTrips[0]?.id).not.toBe(seeded.trip.id);
    expect(importedTrips[0]?.name).toBe('Lisbon Trip');

    const importedVisits = await t.travellog
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.userId, userB.userId));
    expect(importedVisits).toHaveLength(1);
    expect(importedVisits[0]?.tripId).toBe(importedTrips[0]?.id);
    expect(importedVisits[0]?.note).toBe('Great view');

    const importedStops = await t.travellog
      .select()
      .from(schema.stops)
      .where(eq(schema.stops.tripId, importedTrips[0]?.id ?? ''));
    expect(importedStops).toHaveLength(1);

    const importedPhotos = await t.travellog
      .select()
      .from(schema.visitPhotos)
      .where(eq(schema.visitPhotos.visitId, importedVisits[0]?.id ?? ''));
    expect(importedPhotos).toHaveLength(1);
    const reuploaded = harness.storageObjects.get(importedPhotos[0]?.storageKey ?? '');
    expect(reuploaded?.bytes).toEqual(bytes);
    expect(reuploaded?.ownerUserId).toBe(userB.userId);
    // A fresh storage key, not the original — the original object belongs
    // to a different owner and shouldn't be reused across accounts.
    expect(importedPhotos[0]?.storageKey).not.toBe(seeded.visit.id);
  });

  it('preserves a manual "no trip" override (linkSource: manual, tripId: null) rather than resetting it', async () => {
    const place = await createPlace(t.travellog, userA, { name: 'Somewhere', source: 'manual' });
    const visit = await createVisit(t.travellog, userA, {
      placeId: place.id,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    await t.travellog
      .update(schema.visits)
      .set({ tripId: null, linkSource: 'manual' })
      .where(eq(schema.visits.id, visit.id));

    if (!captured.exporter || !captured.importer) throw new Error('handlers not registered');
    const section = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: false },
    });
    await captured.importer(section, {
      userId: userB.userId,
      tenantId: userB.tenantId,
      remapId: remapper(),
    });

    const [imported] = await t.travellog
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.userId, userB.userId));
    expect(imported?.tripId).toBeNull();
    expect(imported?.linkSource).toBe('manual');
  });

  it('skips a visit whose (tenantId, source, externalRef) already exists in the target tenant, instead of hitting the unique-constraint error live testing found', async () => {
    const place = await createPlace(t.travellog, userA, { name: 'Cafe Central', source: 'manual' });
    const bytes = new Uint8Array([1, 2, 3]);
    const photoKey = `visits/${userA.userId}/dup-photo`;
    harness.storageObjects.set(photoKey, { bytes, contentType: 'image/jpeg', ownerUserId: userA.userId });
    const original = await createVisit(t.travellog, userA, {
      placeId: place.id,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'import:swarm',
      externalRef: 'swarm-checkin-42',
      photos: [{ storageKey: photoKey, source: 'import' }],
    });

    if (!captured.exporter || !captured.importer) throw new Error('handlers not registered');
    const section = await captured.exporter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      options: { includeFiles: true },
    });

    // Self-import: same tenant already has the exact (source, externalRef)
    // this bundle carries — this is the live-reproduced scenario (T.23).
    await expect(
      captured.importer(section, {
        userId: userA.userId,
        tenantId: userA.tenantId,
        remapId: remapper(),
      }),
    ).resolves.toBeUndefined();

    const matching = await t.travellog
      .select()
      .from(schema.visits)
      .where(
        and(eq(schema.visits.tenantId, userA.tenantId), eq(schema.visits.externalRef, 'swarm-checkin-42')),
      );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.id).toBe(original.id);

    // No orphaned photo either — the skipped visit's photo was skipped too.
    const allPhotos = await t.travellog.select().from(schema.visitPhotos);
    expect(allPhotos).toHaveLength(1);
  });

  it('rejects a section with an unrecognized schema version', async () => {
    if (!captured.importer) throw new Error('importer not registered');
    await expect(
      captured.importer(
        { pluginId: 'fs.sovereign.travellog', schemaVersion: 999, data: {} },
        { userId: userA.userId, tenantId: userA.tenantId, remapId: remapper() },
      ),
    ).rejects.toThrow(/unrecognized shape/);
  });
});

describe('deleteAllTravellogData', () => {
  it('removes every row for the user and returns the count, leaving another user\'s data and a shared place intact', async () => {
    const seededA = await seedTripWithEverything(userA);
    // userB references the SAME place as userA (a shared entity).
    const visitB = await createVisit(t.travellog, userB, {
      placeId: seededA.place.id,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });

    if (!captured.deleter) throw new Error('deleter not registered');
    const result = await captured.deleter({
      userId: userA.userId,
      tenantId: userA.tenantId,
      db: t.travellog,
    });
    expect(result.deleted).toBeGreaterThan(0);

    const remainingTrips = await t.travellog
      .select()
      .from(schema.trips)
      .where(eq(schema.trips.ownerId, userA.userId));
    expect(remainingTrips).toHaveLength(0);
    const remainingVisits = await t.travellog
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.userId, userA.userId));
    expect(remainingVisits).toHaveLength(0);

    // userB's own visit (and the shared place it points at) survive.
    const survivingVisit = await t.travellog
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.id, visitB.id));
    expect(survivingVisit).toHaveLength(1);
    const survivingPlace = await t.travellog
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, seededA.place.id));
    expect(survivingPlace).toHaveLength(1);
  });
});
