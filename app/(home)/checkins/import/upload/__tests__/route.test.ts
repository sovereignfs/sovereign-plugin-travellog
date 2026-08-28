/**
 * Regression coverage for a real bug found live-testing T.8: the uploaded
 * export ZIP was written to `sdk.storage` with `ownerUserId` set, but it is
 * only ever read back from `import-swarm.ts`'s job handler — a background
 * invocation with no ambient user identity (`JobContext` carries a plugin
 * id, never a user id). The platform's storage ownership check
 * (`packages/db`'s `canAccessStorageObject`) denies access whenever
 * `ownerUserId` is set and the reading context's `userId` doesn't match —
 * including `null` — so every import failed with "no longer available in
 * storage" from the moment this route shipped, even though the row and
 * bytes were both genuinely present (confirmed live via a raw table dump
 * before the fix). The fix is to never set `ownerUserId` on this
 * particular object; this test locks that in. See
 * `docs/architecture-rules.md`'s matching entry for the generalized rule.
 */
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../../../../_db/__tests__/test-db';
import { getImportJob } from '../../../../../_lib/import-jobs';

const harness = vi.hoisted(() => ({
  currentUser: { id: 'user-1', tenantId: 'tenant-1' } as { id: string; tenantId: string } | null,
  dbClient: null as unknown,
  putCalls: [] as { key: string; contentType: string; ownerUserId?: string }[],
  enqueueCalls: [] as unknown[],
}));

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    auth: {
      requireSession: vi.fn(async () => {
        if (!harness.currentUser) throw new Error('Not authenticated');
        return { user: harness.currentUser };
      }),
    },
    db: { getClient: vi.fn(async () => harness.dbClient) },
    storage: {
      put: vi.fn(async (input: { key: string; contentType: string; ownerUserId?: string }) => {
        harness.putCalls.push(input);
        return { id: 'obj-1', key: input.key };
      }),
    },
    jobs: {
      enqueue: vi.fn(async (input: unknown) => {
        harness.enqueueCalls.push(input);
        return { id: 'platform-job-1' };
      }),
    },
  },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { POST } from '../route';

/** Cast needed because `zipSync` returns `Uint8Array<ArrayBufferLike>`, which
 * TS's DOM lib no longer widens to `BlobPart` (it wants `ArrayBuffer`, not
 * `ArrayBufferLike`) — a type-only mismatch, fine at runtime. */
function zipOf(checkins: unknown[]): BlobPart {
  return zipSync({ 'checkins.json': strToU8(JSON.stringify(checkins)) }) as unknown as BlobPart;
}

function checkin() {
  return {
    id: 'c1',
    createdAt: 1_700_000_000,
    venue: { id: 'v1', name: 'Corvo Coffee', location: {} },
  };
}

function requestWithFile(file: File | null): Request {
  const formData = new FormData();
  if (file) formData.set('file', file);
  return new Request('http://localhost/travellog/checkins/import/upload', {
    method: 'POST',
    body: formData,
  });
}

let t: TestDb;

beforeEach(async () => {
  vi.clearAllMocks();
  harness.putCalls = [];
  harness.enqueueCalls = [];
  harness.currentUser = { id: 'user-1', tenantId: 'tenant-1' };
  t = await createTestDb();
  harness.dbClient = t.travellog;
});

afterEach(() => {
  t.close();
});

describe('POST /checkins/import/upload', () => {
  it('rejects a request with no file', async () => {
    const response = await POST(requestWithFile(null));
    expect(response.status).toBe(400);
  });

  it('rejects a non-zip file', async () => {
    const response = await POST(requestWithFile(new File(['x'], 'a.txt', { type: 'text/plain' })));
    expect(response.status).toBe(400);
  });

  it('rejects a malformed export before ever storing or enqueueing it', async () => {
    const bad = zipSync({ 'other.json': strToU8('{}') }) as unknown as BlobPart;
    const response = await POST(
      requestWithFile(new File([bad], 'export.zip', { type: 'application/zip' })),
    );
    expect(response.status).toBe(400);
    expect(harness.putCalls).toHaveLength(0);
    expect(harness.enqueueCalls).toHaveLength(0);
  });

  it('stores the export WITHOUT ownerUserId, since only the job handler (no user context) reads it back', async () => {
    const zip = zipOf([checkin()]);
    const response = await POST(
      requestWithFile(new File([zip], 'export.zip', { type: 'application/zip' })),
    );

    expect(response.status).toBe(200);
    expect(harness.putCalls).toHaveLength(1);
    const put = harness.putCalls[0];
    expect(put?.key).toMatch(/^imports\/user-1\//);
    expect(put).not.toHaveProperty('ownerUserId');

    const body = (await response.json()) as { importJobId: string };
    const job = await getImportJob(t.travellog, body.importJobId);
    expect(job?.storageKey).toBe(put?.key);
    expect(job?.platformJobId).toBe('platform-job-1');
  });
});
