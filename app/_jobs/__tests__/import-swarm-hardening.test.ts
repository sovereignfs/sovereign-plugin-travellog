/**
 * Review-driven hardening of the Swarm import job: photo URLs are
 * allowlisted (the ZIP is attacker-controlled input), a mid-loop failure
 * marks the plugin's own row `failed`, a malformed entry is skipped rather
 * than aborting, cancellation stops at the next checkpoint, and the
 * uploaded ZIP is removed once the import finishes.
 */
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { fakeOpen, fakeRegisterTables, fakeSeal } from '../../_db/__tests__/crypto-mock';
import { cancelImportJob, createImportJob, getImportJob } from '../../_lib/import-jobs';

const harness = vi.hoisted(() => ({
  dbClient: null as unknown,
  storageObjects: new Map<string, Uint8Array>(),
  putCalls: [] as { key: string; contentType: string }[],
  deleteCalls: [] as string[],
  notificationsSent: [] as { title: string }[],
  failPutOnce: false,
  /** When set, `findOrCreateImportedPlace` throws for a venue of this name — simulates a DB failure mid-loop. */
  explodeOnVenue: null as string | null,
}));

vi.mock('../../_lib/places', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../_lib/places')>();
  return {
    ...real,
    findOrCreateImportedPlace: async (
      ...args: Parameters<typeof real.findOrCreateImportedPlace>
    ) => {
      if (harness.explodeOnVenue && args[2].name === harness.explodeOnVenue) {
        throw new Error('places table on fire');
      }
      return real.findOrCreateImportedPlace(...args);
    },
  };
});

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    db: { getClient: vi.fn(async () => harness.dbClient) },
    crypto: { seal: fakeSeal, open: fakeOpen, registerTables: fakeRegisterTables },
    storage: {
      delete: vi.fn(async (key: string) => {
        harness.deleteCalls.push(key);
      }),
      get: vi.fn(async (key: string) => {
        const bytes = harness.storageObjects.get(key);
        if (!bytes) return null;
        return {
          key,
          contentType: 'application/zip',
          body: new Blob([new Uint8Array(bytes)]).stream(),
        };
      }),
      put: vi.fn(async (input: { key: string; contentType: string }) => {
        if (harness.failPutOnce) {
          harness.failPutOnce = false;
          throw new Error('storage exploded');
        }
        harness.putCalls.push({ key: input.key, contentType: input.contentType });
        return { key: input.key };
      }),
    },
    notifications: {
      send: vi.fn(async (input: { title: string }) => {
        harness.notificationsSent.push(input);
      }),
    },
  },
}));

import handleImportSwarm, { isAllowedPhotoUrl } from '../import-swarm';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
const IMPORT_ZIP_KEY = 'imports/user-1/export.zip';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function fakeCtx() {
  return {
    pluginId: 'fs.sovereign.travellog',
    jobId: 'platform-job-1',
    type: 'import.swarm',
    attempt: 1,
    headers: new Headers(),
    reportProgress: vi.fn(async () => {}),
  };
}

function checkin(id: string, photoPrefix?: string) {
  return {
    id,
    createdAt: 1_700_000_000,
    timeZoneOffset: 0,
    venue: { id: `v-${id}`, name: `Venue ${id}`, location: { lat: 1, lng: 2 } },
    photos: photoPrefix ? [{ prefix: photoPrefix, suffix: '/p.jpg' }] : [],
  };
}

function zipOf(entries: unknown[]): Uint8Array {
  return zipSync({ 'checkins.json': strToU8(JSON.stringify(entries)) });
}

let t: TestDb;

beforeEach(async () => {
  vi.clearAllMocks();
  harness.storageObjects.clear();
  harness.putCalls = [];
  harness.deleteCalls = [];
  harness.notificationsSent = [];
  harness.failPutOnce = false;
  harness.explodeOnVenue = null;
  t = await createTestDb();
  harness.dbClient = t.travellog;
});

afterEach(() => {
  t.close();
  vi.unstubAllGlobals();
});

describe('isAllowedPhotoUrl', () => {
  it('accepts Foursquare CDN hosts over https only', () => {
    expect(isAllowedPhotoUrl('https://fastly.4sqi.net/img/general/500x500/x.jpg')).toBe(true);
    expect(isAllowedPhotoUrl('https://igx.4sqi.net/img/x.jpg')).toBe(true);
    expect(isAllowedPhotoUrl('http://fastly.4sqi.net/img/x.jpg')).toBe(false);
    expect(isAllowedPhotoUrl('https://evil.example/4sqi.net/x.jpg')).toBe(false);
    expect(isAllowedPhotoUrl('https://fastly.4sqi.net.evil.example/x.jpg')).toBe(false);
    expect(isAllowedPhotoUrl('https://user:pw@fastly.4sqi.net/x.jpg')).toBe(false);
    expect(isAllowedPhotoUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedPhotoUrl('not a url')).toBe(false);
  });
});

describe('handleImportSwarm hardening', () => {
  it('never fetches a photo URL outside the allowlist — counted as a failed photo, the check-in still imports', async () => {
    const fetchMock = vi.fn(async () => new Response(JPEG_BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    harness.storageObjects.set(
      IMPORT_ZIP_KEY,
      zipOf([checkin('c1', 'https://169.254.169.254/latest/')]),
    );
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    expect(fetchMock).not.toHaveBeenCalled();
    const row = await getImportJob(t.travellog, job.id);
    expect(row).toMatchObject({ status: 'completed', failedPhotos: 1, processedPhotos: 0 });
    expect(await t.db.select().from(schema.visits)).toHaveLength(1);
  });

  it('does not follow redirects and refuses a non-image body even when labelled image/*', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    harness.storageObjects.set(
      IMPORT_ZIP_KEY,
      zipOf([checkin('c1', 'https://fastly.4sqi.net/img/')]),
    );
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.putCalls).toEqual([]);
    expect((await getImportJob(t.travellog, job.id))?.failedPhotos).toBe(1);
  });

  it('a malformed (null) entry in checkins.json is skipped, not fatal', async () => {
    vi.stubGlobal('fetch', vi.fn());
    harness.storageObjects.set(
      IMPORT_ZIP_KEY,
      zipOf([null, 42, checkin('c1'), { id: 'no-venue' }]),
    );
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    expect((await getImportJob(t.travellog, job.id))?.status).toBe('completed');
    expect(await t.db.select().from(schema.visits)).toHaveLength(1);
  });

  it('a failure mid-loop marks the plugin row failed with the message, then re-throws for the platform', async () => {
    vi.stubGlobal('fetch', vi.fn());
    harness.storageObjects.set(IMPORT_ZIP_KEY, zipOf([checkin('c1'), checkin('c2')]));
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);
    harness.explodeOnVenue = 'Venue c2';

    await expect(handleImportSwarm(fakeCtx(), { importJobId: job.id })).rejects.toThrow(
      'places table on fire',
    );

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/on fire/);
    expect(harness.deleteCalls).toEqual([]); // the ZIP survives a failure so Resume can use it
  });

  it('stops at the next checkpoint once cancelled, keeping the cursor, and leaves the ZIP in place', async () => {
    vi.stubGlobal('fetch', vi.fn());
    // 12 check-ins: progress persists every 5, so cancelling during the run stops after 5 or 10.
    harness.storageObjects.set(
      IMPORT_ZIP_KEY,
      zipOf(Array.from({ length: 12 }, (_, i) => checkin(`c${String(i)}`))),
    );
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);
    const ctx = fakeCtx();
    ctx.reportProgress = vi.fn(async () => {
      await cancelImportJob(t.travellog, job.id);
    });

    await handleImportSwarm(ctx, { importJobId: job.id });

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cursor).toBe(5);
    expect(await t.db.select().from(schema.visits)).toHaveLength(5);
    expect(harness.deleteCalls).toEqual([]);
    expect(harness.notificationsSent).toEqual([]);
  });

  it('removes the uploaded ZIP once the import completes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    harness.storageObjects.set(IMPORT_ZIP_KEY, zipOf([checkin('c1')]));
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);
    await handleImportSwarm(fakeCtx(), { importJobId: job.id });
    expect(harness.deleteCalls).toEqual([IMPORT_ZIP_KEY]);
  });
});
