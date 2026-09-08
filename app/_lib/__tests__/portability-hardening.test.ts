/**
 * Review-driven hardening of the portability handlers: day-level
 * attachments round-trip, blobs are staged before the import transaction
 * (and removed if it rolls back), a re-import reuses places by provenance,
 * and the deletion sweep is transactional, removes import jobs + their
 * ZIPs, and severs `places.created_by` instead of leaving a dangling id.
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
import { fakeOpen, fakeRegisterTables, fakeSeal } from '../../_db/__tests__/crypto-mock';
import * as schema from '../../_db/schema';
import { createAttachment } from '../attachments';
import { createImportJob } from '../import-jobs';
import { createPlace } from '../places';
import { createStop, listTripDays } from '../stops';
import { createTrip } from '../trips';
import { createVisit } from '../visits';

let dbClient: unknown = null;

const harness = vi.hoisted(() => ({
  storageObjects: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  deleteCalls: [] as string[],
}));

const captured = {
  exporter: null as ((ctx: ExportContext) => Promise<PluginExportSection>) | null,
  importer: null as ((section: PluginExportSection, ctx: ImportContext) => Promise<void>) | null,
  deleter: null as ((ctx: DeletionContext) => Promise<DeletionResult>) | null,
};

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    db: { getClient: vi.fn(async () => dbClient) },
    crypto: { seal: fakeSeal, open: fakeOpen, registerTables: fakeRegisterTables },
    storage: {
      get: vi.fn(async (key: string) => {
        const stored = harness.storageObjects.get(key);
        if (!stored) return null;
        return {
          key,
          contentType: stored.contentType,
          body: new Blob([new Uint8Array(stored.bytes)]).stream(),
        };
      }),
      put: vi.fn(async (input: { key: string; body: Uint8Array; contentType: string }) => {
        harness.storageObjects.set(input.key, {
          bytes: input.body,
          contentType: input.contentType,
        });
        return { key: input.key };
      }),
      delete: vi.fn(async (key: string) => {
        harness.deleteCalls.push(key);
        harness.storageObjects.delete(key);
      }),
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
  return (id: string): string => {
    let mapped = map.get(id);
    if (!mapped) {
      mapped = `remapped-${String(map.size)}`;
      map.set(id, mapped);
    }
    return mapped;
  };
}

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  dbClient = t.travellog;
  harness.storageObjects.clear();
  harness.deleteCalls = [];
  await registerPortabilityHandlers();
});

afterEach(() => {
  t.close();
});

async function exportFor(actor: typeof userA, includeFiles = true) {
  if (!captured.exporter) throw new Error('exporter not registered');
  return captured.exporter({
    userId: actor.userId,
    tenantId: actor.tenantId,
    options: { includeFiles },
  } as ExportContext);
}

describe('export — day-level attachments', () => {
  it('includes an attachment tied to a day, not just trip-level ones', async () => {
    const place = await createPlace(t.travellog, userA, { name: 'P', source: 'manual' });
    const trip = await createTrip(t.travellog, userA, 'Trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId: place.id,
      arriveDate: '2026-06-01',
      departDate: '2026-06-01',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a day');
    harness.storageObjects.set('attachments/user-a/day', {
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
    });
    await createAttachment(t.travellog, userA, {
      tripDayId: day.id,
      kind: 'booking',
      title: 'Day booking',
      storageKey: 'attachments/user-a/day',
    });

    const section = await exportFor(userA);
    const data = section.data as {
      attachments: Array<{ title: string; tripDayId: string | null; blobPath: string | null }>;
    };
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0]).toMatchObject({
      title: 'Day booking',
      tripDayId: day.id,
      blobPath: expect.any(String),
    });
  });
});

describe('import — staged blobs and place provenance', () => {
  it('reuses an existing place with the same (source, sourceRef) instead of duplicating it', async () => {
    const existing = await createPlace(t.travellog, userA, {
      name: 'Corvo',
      source: 'import',
      sourceRef: 'fsq-1',
    });
    const section: PluginExportSection = {
      pluginId: 'fs.sovereign.travellog',
      schemaVersion: 1,
      data: {
        places: [
          {
            id: 'p1',
            name: 'Corvo (exported)',
            category: null,
            lat: null,
            lng: null,
            address: null,
            city: null,
            state: null,
            country: null,
            countryCode: null,
            postalCode: null,
            source: 'import',
            sourceRef: 'fsq-1',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        visits: [
          {
            id: 'v1',
            placeId: 'p1',
            happenedAt: 1_700_000_000_000,
            tzIana: 'UTC',
            tzOffsetMinutes: 0,
            note: null,
            companions: [],
            tripId: null,
            linkSource: null,
            source: 'manual',
            externalRef: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        visitPhotos: [],
        trips: [],
        stops: [],
        tripDays: [],
        itineraryItems: [],
        attachments: [],
      },
    };
    if (!captured.importer) throw new Error('importer not registered');
    await captured.importer(section, {
      userId: userA.userId,
      tenantId: userA.tenantId,
      remapId: remapper(),
    } as ImportContext);

    const places = await t.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.sourceRef, 'fsq-1'));
    expect(places).toHaveLength(1);
    const [visit] = await t.db.select().from(schema.visits);
    expect(visit?.placeId).toBe(existing.id);
  });

  it('removes staged blobs when the import transaction fails, leaving no orphaned objects', async () => {
    const section: PluginExportSection = {
      pluginId: 'fs.sovereign.travellog',
      schemaVersion: 1,
      data: {
        places: [],
        // A visit pointing at a place that isn't in the bundle → FK failure inside the tx.
        visits: [
          {
            id: 'v1',
            placeId: 'missing',
            happenedAt: 1_700_000_000_000,
            tzIana: 'UTC',
            tzOffsetMinutes: 0,
            note: null,
            companions: [],
            tripId: null,
            linkSource: null,
            source: 'manual',
            externalRef: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        visitPhotos: [
          {
            id: 'ph1',
            visitId: 'v1',
            blobPath: 'visit-photos/ph1',
            contentType: 'image/jpeg',
            position: 1024,
            source: 'upload',
            createdAt: 1,
          },
        ],
        trips: [],
        stops: [],
        tripDays: [],
        itineraryItems: [],
        attachments: [],
      },
      blobs: { 'visit-photos/ph1': new Uint8Array([0xff, 0xd8]) },
    };
    if (!captured.importer) throw new Error('importer not registered');
    await expect(
      captured.importer(section, {
        userId: userA.userId,
        tenantId: userA.tenantId,
        remapId: remapper(),
      } as ImportContext),
    ).rejects.toThrow();

    expect(harness.deleteCalls).toHaveLength(1);
    expect(harness.deleteCalls[0]).toMatch(/^visits\/user-a\//);
    expect(harness.storageObjects.size).toBe(0);
    expect(await t.db.select().from(schema.visits)).toEqual([]);
  });

  it('rejects a section missing one of the array fields with a clear shape error, not a TypeError', async () => {
    if (!captured.importer) throw new Error('importer not registered');
    await expect(
      captured.importer(
        {
          pluginId: 'fs.sovereign.travellog',
          schemaVersion: 1,
          data: { places: [], visits: [], trips: [], stops: [] },
        },
        { userId: userA.userId, tenantId: userA.tenantId, remapId: remapper() } as ImportContext,
      ),
    ).rejects.toThrow(/unrecognized shape/);
  });
});

describe('delete — sweep completeness', () => {
  it('removes import jobs and their ZIPs, severs place attribution (counted as anonymized), and deletes owned blobs', async () => {
    const shared = await createPlace(t.travellog, userA, { name: 'Shared café', source: 'manual' });
    await createVisit(t.travellog, userB, {
      placeId: shared.id,
      happenedAt: 1_700_000_000_000,
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    await createVisit(t.travellog, userA, {
      placeId: shared.id,
      happenedAt: 1_700_000_000_000,
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
      photos: [{ storageKey: 'visits/user-a/photo', source: 'upload' }],
    });
    await createImportJob(t.travellog, userA, 'imports/user-a/export.zip');
    const trip = await createTrip(t.travellog, userA, 'Trip');
    const stop = await createStop(t.travellog, trip.id, {
      placeId: shared.id,
      arriveDate: '2026-06-01',
      departDate: '2026-06-01',
    });
    const [day] = await listTripDays(t.travellog, stop.id);
    if (!day) throw new Error('expected a day');
    await createAttachment(t.travellog, userA, {
      tripDayId: day.id,
      kind: 'other',
      title: 'Day',
      storageKey: 'attachments/user-a/day',
    });

    if (!captured.deleter) throw new Error('deleter not registered');
    const result = await captured.deleter({
      db: t.travellog,
      userId: userA.userId,
      tenantId: userA.tenantId,
    } as DeletionContext);

    expect(result.anonymized).toBe(1);
    const [placeRow] = await t.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, shared.id));
    expect(placeRow?.createdBy).toBeNull(); // the row survives for user B; the attribution is gone
    expect(await t.db.select().from(schema.importJobs)).toEqual([]);
    expect(await t.db.select().from(schema.attachments)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(schema.visits)
        .where(and(eq(schema.visits.userId, userA.userId))),
    ).toEqual([]);
    expect(
      await t.db.select().from(schema.visits).where(eq(schema.visits.userId, userB.userId)),
    ).toHaveLength(1);
    expect([...harness.deleteCalls].sort()).toEqual([
      'attachments/user-a/day',
      'imports/user-a/export.zip',
      'visits/user-a/photo',
    ]);
  });
});
