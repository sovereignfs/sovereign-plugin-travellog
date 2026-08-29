/**
 * `T.8`'s review checklist, verified directly against the real job handler
 * and a real (ephemeral) database — not just the pure mapping logic in
 * `swarm-import.test.ts`: interrupting and resuming continues from the
 * cursor rather than from zero; re-running an already-completed import
 * creates no duplicate rows; a photo that fails to fetch doesn't abort the
 * job. `@sovereignfs/sdk` is mocked the same way `app/__tests__/actions.test.ts`
 * mocks it; `fetch` is stubbed per-test for the photo-fetch step.
 */
import { strToU8, zipSync } from 'fflate';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { fakeOpen, fakeRegisterTables, fakeSeal } from '../../_db/__tests__/crypto-mock';
import { createImportJob, getImportJob, updateImportJobProgress } from '../../_lib/import-jobs';

const harness = vi.hoisted(() => ({
  dbClient: null as unknown,
  storageObjects: new Map<string, Uint8Array>(),
  putCalls: [] as { key: string; contentType: string; ownerUserId?: string }[],
  notificationsSent: [] as { recipientUserId: string; title: string; body?: string }[],
}));

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    db: { getClient: vi.fn(async () => harness.dbClient) },
    crypto: { seal: fakeSeal, open: fakeOpen, registerTables: fakeRegisterTables },
    storage: {
      get: vi.fn(async (key: string) => {
        const bytes = harness.storageObjects.get(key);
        if (!bytes) return null;
        return {
          id: key,
          key,
          contentType: 'application/zip',
          size: bytes.length,
          checksum: '',
          metadata: null,
          ownerUserId: null,
          createdAt: 0,
          updatedAt: 0,
          body: new Blob([new Uint8Array(bytes)]).stream(),
        };
      }),
      put: vi.fn(async (input: { key?: string; contentType: string; ownerUserId?: string }) => {
        const key = input.key ?? `stored/${String(harness.putCalls.length)}`;
        harness.putCalls.push({ key, contentType: input.contentType, ownerUserId: input.ownerUserId });
        return {
          id: key,
          key,
          contentType: input.contentType,
          size: 0,
          checksum: '',
          metadata: null,
          ownerUserId: input.ownerUserId ?? null,
          createdAt: 0,
          updatedAt: 0,
        };
      }),
    },
    notifications: {
      send: vi.fn(async (input: { recipientUserId: string; title: string; body?: string }) => {
        harness.notificationsSent.push(input);
      }),
    },
  },
}));

import handleImportSwarm from '../import-swarm';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
const IMPORT_ZIP_KEY = 'imports/user-1/export.zip';

function fakeCtx() {
  return {
    pluginId: 'fs.sovereign.travellog',
    jobId: 'platform-job-1',
    type: 'import.swarm',
    attempt: 1,
    headers: new Headers({ 'x-sovereign-plugin-id': 'fs.sovereign.travellog' }),
    reportProgress: vi.fn(async () => {}),
  };
}

function checkin(id: string, venueId: string, venueName: string, photoCount = 0) {
  return {
    id,
    createdAt: 1_700_000_000,
    timeZoneOffset: 0,
    shout: `Note for ${id}`,
    venue: { id: venueId, name: venueName, location: { lat: 1, lng: 2, city: 'Testville' } },
    photos: {
      items: Array.from({ length: photoCount }, (_, i) => ({
        prefix: `https://photos.example/${id}-`,
        suffix: `-${String(i)}.jpg`,
      })),
    },
  };
}

function zipOf(checkins: unknown[]): Uint8Array {
  return zipSync({ 'checkins.json': strToU8(JSON.stringify(checkins)) });
}

async function importedVisits(t: TestDb) {
  return t.db
    .select()
    .from(schema.visits)
    .where(and(eq(schema.visits.tenantId, actor.tenantId), eq(schema.visits.source, 'import:swarm')))
    .orderBy(schema.visits.externalRef);
}

let t: TestDb;

beforeEach(async () => {
  vi.clearAllMocks();
  harness.storageObjects.clear();
  harness.putCalls = [];
  harness.notificationsSent = [];
  t = await createTestDb();
  harness.dbClient = t.travellog;
});

afterEach(() => {
  t.close();
  vi.unstubAllGlobals();
});

describe('handleImportSwarm — happy path', () => {
  it('imports every checkin, marks the job completed, and sends a notification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } })));

    const zip = zipOf([checkin('c1', 'v1', 'Corvo Coffee', 1), checkin('c2', 'v2', 'Time Out Market', 0)]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('completed');
    expect(row?.processedCheckins).toBe(2);
    expect(row?.totalCheckins).toBe(2);
    expect(row?.processedPhotos).toBe(1);
    expect(row?.completedAt).not.toBeNull();

    const visits = await importedVisits(t);
    expect(visits.map((v) => v.externalRef)).toEqual(['c1', 'c2']);

    expect(harness.notificationsSent).toHaveLength(1);
    expect(harness.notificationsSent[0]?.recipientUserId).toBe(actor.userId);
  });
});

describe('handleImportSwarm — resume from cursor (review checklist)', () => {
  it('does not reprocess checkins before the cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } })));

    const zip = zipOf([checkin('c1', 'v1', 'First'), checkin('c2', 'v2', 'Second'), checkin('c3', 'v3', 'Third')]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    // Simulate an earlier attempt that crashed after fully processing c1
    // (cursor=1) — never having touched c2/c3.
    await updateImportJobProgress(t.travellog, job.id, {
      cursor: 1,
      processedCheckins: 1,
      processedPhotos: 0,
      failedPhotos: 0,
    });

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    const row = await getImportJob(t.travellog, job.id);
    // Started counting from the resumed baseline (1) plus the 2 remaining.
    expect(row?.processedCheckins).toBe(3);

    const visits = await importedVisits(t);
    // c1 was never (re-)inserted by this run — only c2 and c3 exist.
    expect(visits.map((v) => v.externalRef).sort()).toEqual(['c2', 'c3']);
  });

  it('a resumed run that reaches an already-imported checkin (inserted by the crashed attempt just before it died) skips it without erroring', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })));

    const zip = zipOf([checkin('c1', 'v1', 'First'), checkin('c2', 'v2', 'Second')]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    // The crashed attempt actually inserted c1's visit before dying, but
    // never got to persist cursor=1 — a realistic race this job must
    // tolerate, not just the tidy "cursor already reflects reality" case.
    await t.db.insert(schema.places).values({
      id: 'place-1',
      tenantId: actor.tenantId,
      name: 'First',
      source: 'import',
      sourceRef: 'v1',
      createdBy: actor.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await t.db.insert(schema.visits).values({
      id: 'visit-1',
      tenantId: actor.tenantId,
      userId: actor.userId,
      placeId: 'place-1',
      happenedAt: 1_700_000_000_000,
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'import:swarm',
      externalRef: 'c1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('completed');
    const visits = await importedVisits(t);
    expect(visits).toHaveLength(2);
    expect(visits.filter((v) => v.externalRef === 'c1')).toHaveLength(1);
  });
});

describe('handleImportSwarm — re-running an already-completed import (review checklist)', () => {
  it('creates no duplicate rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } })));

    const zip = zipOf([checkin('c1', 'v1', 'Corvo Coffee', 1), checkin('c2', 'v2', 'Time Out Market')]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });
    const afterFirst = await importedVisits(t);
    expect(afterFirst).toHaveLength(2);

    // Re-run the identical job from scratch (cursor reset to 0) — the same
    // export uploaded again, or a stray duplicate enqueue.
    await updateImportJobProgress(t.travellog, job.id, {
      cursor: 0,
      processedCheckins: 0,
      processedPhotos: 0,
      failedPhotos: 0,
    });
    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    const afterSecond = await importedVisits(t);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond.map((v) => v.externalRef).sort()).toEqual(['c1', 'c2']);

    // The venue was reused too, not duplicated into a second place row.
    const places = await t.db.select().from(schema.places).where(eq(schema.places.sourceRef, 'v1'));
    expect(places).toHaveLength(1);
  });

  it('a stray re-enqueue after the job already shows completed is a pure no-op', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })));

    const zip = zipOf([checkin('c1', 'v1', 'Corvo Coffee')]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });
    expect(harness.notificationsSent).toHaveLength(1);

    // Second invocation against the same (now completed) row.
    await handleImportSwarm(fakeCtx(), { importJobId: job.id });
    // No second notification, no re-processing — an early return.
    expect(harness.notificationsSent).toHaveLength(1);
  });
});

describe('handleImportSwarm — a failed photo does not abort the job (review checklist)', () => {
  it('imports the check-in and continues past a 404 photo, counting it as failed not fatal', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) return new Response(null, { status: 404 });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }),
    );

    const zip = zipOf([checkin('c1', 'v1', 'Corvo Coffee', 2)]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('completed');
    expect(row?.processedPhotos).toBe(1);
    expect(row?.failedPhotos).toBe(1);

    const visits = await importedVisits(t);
    expect(visits).toHaveLength(1);
  });

  it('a checkin with every photo failing still imports, with zero photos attached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

    const zip = zipOf([checkin('c1', 'v1', 'Corvo Coffee', 2)]);
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await handleImportSwarm(fakeCtx(), { importJobId: job.id });

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('completed');
    expect(row?.failedPhotos).toBe(2);
    expect(row?.processedPhotos).toBe(0);
    expect(await importedVisits(t)).toHaveLength(1);
  });
});

describe('handleImportSwarm — a malformed export fails the job, not silently', () => {
  it('marks the job failed with a clear message when checkins.json is missing', async () => {
    const zip = zipSync({ 'other.json': strToU8('{}') });
    harness.storageObjects.set(IMPORT_ZIP_KEY, zip);
    const job = await createImportJob(t.travellog, actor, IMPORT_ZIP_KEY);

    await expect(handleImportSwarm(fakeCtx(), { importJobId: job.id })).rejects.toThrow();

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/checkins\.json/);
  });
});
