/**
 * Same mocking approach as `T.7`'s `checkin/upload-photo/__tests__/route.test.ts`
 * and `T.8`'s `checkins/import/upload/__tests__/route.test.ts` — `@sovereignfs/sdk`
 * mocked with a `vi.hoisted()` harness, ownership checked against a real
 * ephemeral DB (not mocked), since that's the actual point of this route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../../../../_db/__tests__/test-db';
import { createTrip } from '../../../../../_lib/trips';
import { createStop, listTripDays } from '../../../../../_lib/stops';
import * as schema from '../../../../../_db/schema';

const harness = vi.hoisted(() => ({
  currentUser: { id: 'user-1', tenantId: 'tenant-1' } as { id: string; tenantId: string } | null,
  putCalls: [] as { key: string; contentType: string; ownerUserId?: string }[],
  dbClient: null as unknown,
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
  },
}));

import { POST } from '../route';

function requestWithFile(file: File | null, target: Record<string, string> = {}): Request {
  const formData = new FormData();
  if (file) formData.set('file', file);
  for (const [key, value] of Object.entries(target)) formData.set(key, value);
  return new Request('http://localhost/travellog/trips/attachments/upload', {
    method: 'POST',
    body: formData,
  });
}

let t: TestDb;
let tripId: string;
let tripDayId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  harness.putCalls = [];
  harness.currentUser = { id: 'user-1', tenantId: 'tenant-1' };
  t = await createTestDb();
  harness.dbClient = t.travellog;

  const trip = await createTrip(t.travellog, { userId: 'user-1', tenantId: 'tenant-1' }, 'Portugal 2026');
  tripId = trip.id;
  const now = Date.now();
  await t.db.insert(schema.places).values({
    id: 'place-1',
    tenantId: 'tenant-1',
    name: 'Belém Tower',
    source: 'manual',
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
  });
  const stop = await createStop(t.travellog, tripId, {
    placeId: 'place-1',
    arriveDate: '2026-09-01',
    departDate: '2026-09-01',
  });
  const [day] = await listTripDays(t.travellog, stop.id);
  if (!day) throw new Error('expected a trip day');
  tripDayId = day.id;
});

afterEach(() => {
  t.close();
});

describe('POST /trips/attachments/upload', () => {
  it('rejects a request with no file', async () => {
    const response = await POST(requestWithFile(null, { tripId }));
    expect(response.status).toBe(400);
  });

  it('rejects a target with neither tripId nor tripDayId', async () => {
    const response = await POST(requestWithFile(new File(['x'], 'a.pdf', { type: 'application/pdf' })));
    expect(response.status).toBe(400);
  });

  it('rejects a target with both tripId and tripDayId', async () => {
    const response = await POST(
      requestWithFile(new File(['x'], 'a.pdf', { type: 'application/pdf' }), { tripId, tripDayId }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects an empty file', async () => {
    const response = await POST(
      requestWithFile(new File([], 'a.pdf', { type: 'application/pdf' }), { tripId }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a file over the size cap', async () => {
    const big = new Uint8Array(16 * 1024 * 1024);
    const response = await POST(
      requestWithFile(new File([big], 'a.pdf', { type: 'application/pdf' }), { tripId }),
    );
    expect(response.status).toBe(400);
  });

  it('denies a non-owner uploading to a trip that isn’t theirs, as not-found', async () => {
    harness.currentUser = { id: 'user-2', tenantId: 'tenant-1' };
    const response = await POST(
      requestWithFile(new File(['x'], 'a.pdf', { type: 'application/pdf' }), { tripId }),
    );
    expect(response.status).toBe(404);
    expect(harness.putCalls).toHaveLength(0);
  });

  it('uploads to a trip-level target and returns the storage key', async () => {
    const response = await POST(
      requestWithFile(new File(['x'], 'a.pdf', { type: 'application/pdf' }), { tripId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { storageKey: string };
    expect(body.storageKey).toMatch(/^attachments\/user-1\//);
    expect(harness.putCalls).toHaveLength(1);
    expect(harness.putCalls[0]).toMatchObject({ ownerUserId: 'user-1' });
  });

  it('uploads to a day-level target and returns the storage key', async () => {
    const response = await POST(
      requestWithFile(new File(['x'], 'a.pdf', { type: 'application/pdf' }), { tripDayId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { storageKey: string };
    expect(body.storageKey).toMatch(/^attachments\/user-1\//);
  });
});
