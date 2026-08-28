/**
 * `getPlaceProvider()`'s own composition/wiring behavior (T.3a): resolving
 * the configured Nominatim base URL via `sdk.env.get()`, and merging local
 * matches with OSM ones. The network is mocked — this suite never makes a
 * real request (that's a manual, one-off live check per SPEC.md's T.3a
 * review checklist, not something the automated suite should do against a
 * third-party service on every run). Manual-provider-specific behavior
 * (tenant scoping, near-sort, etc.) is covered in
 * `manual-place-provider.test.ts`; OSM-provider-specific behavior
 * (caching, rate-limiting, response mapping) is covered in
 * `osm-place-provider.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createPlace } from '../places';

const harness = vi.hoisted(() => ({ nominatimBaseUrl: null as string | null }));

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    env: {
      get: vi.fn(async (key: string) =>
        key === 'NOMINATIM_BASE_URL' ? harness.nominatimBaseUrl : null,
      ),
    },
  },
}));

import { DEFAULT_NOMINATIM_BASE_URL, getPlaceProvider } from '../place-provider';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  harness.nominatimBaseUrl = null;
});

afterEach(() => {
  t.close();
  vi.unstubAllGlobals();
});

describe('getPlaceProvider', () => {
  it('resolves the public Nominatim URL by default', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = await getPlaceProvider(t.travellog, ctx);
    await provider.search('anything');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl.startsWith(DEFAULT_NOMINATIM_BASE_URL)).toBe(true);
  });

  it("uses the operator's configured base URL when set", async () => {
    harness.nominatimBaseUrl = 'https://nominatim.example.internal';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = await getPlaceProvider(t.travellog, ctx);
    await provider.search('anything');

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl.startsWith('https://nominatim.example.internal')).toBe(true);
  });

  it('merges local matches with OSM matches, local first', async () => {
    const local = await createPlace(t.travellog, ctx, { name: 'Coffee House', source: 'manual' });
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          place_id: 42,
          lat: '38.71',
          lon: '-9.14',
          display_name: 'Coffee House OSM, Lisbon, Portugal',
          type: 'cafe',
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = await getPlaceProvider(t.travellog, ctx);
    const results = await provider.search('Coffee House');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: 'Coffee House', existingPlaceId: local.id });
    expect(results[1]).toMatchObject({ name: 'Coffee House OSM', sourceRef: '42' });
    expect(results[1]?.existingPlaceId).toBeUndefined();
  });

  it('still returns local results when the OSM request fails outright', async () => {
    await createPlace(t.travellog, ctx, { name: 'Reliable Local Place', source: 'manual' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const provider = await getPlaceProvider(t.travellog, ctx);
    const results = await provider.search('Reliable Local Place');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Reliable Local Place' });
  });
});
