/**
 * The manual provider's own behavior, tested directly against
 * `createManualPlaceProvider` rather than through the `getPlaceProvider()`
 * factory — the factory's own composition/config-resolution behavior
 * (merging in the OSM provider, resolving `NOMINATIM_BASE_URL`) is covered
 * separately in `place-provider.test.ts`, with the network mocked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createManualPlaceProvider } from '../providers/manual-place-provider';
import { createPlace } from '../places';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

describe('createManualPlaceProvider (T.3)', () => {
  it('matches an existing place by partial, case-insensitive name', async () => {
    await createPlace(t.travellog, ctx, { name: 'Belém Tower', source: 'manual' });
    const provider = createManualPlaceProvider(t.travellog, ctx);

    const results = await provider.search('belém');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Belém Tower' });
    // The candidate carries the existing row's id — callers must reuse it,
    // not call createPlace() again for the same place.
    expect(results[0]?.existingPlaceId).toBeDefined();
  });

  it('returns an empty array — never an error — when nothing matches, so the caller can always offer "create new"', async () => {
    const provider = createManualPlaceProvider(t.travellog, ctx);
    const results = await provider.search('a place that has never been created');
    expect(results).toEqual([]);
  });

  it('returns an empty array for a blank query without touching the database', async () => {
    const provider = createManualPlaceProvider(t.travellog, ctx);
    expect(await provider.search('   ')).toEqual([]);
  });

  it('scopes results to the calling tenant', async () => {
    await createPlace(t.travellog, ctx, { name: 'Shared Name Café', source: 'manual' });
    await createPlace(
      t.travellog,
      { tenantId: 'tenant-2', userId: 'user-2' },
      { name: 'Shared Name Café', source: 'manual' },
    );

    const provider = createManualPlaceProvider(t.travellog, ctx);
    const results = await provider.search('Shared Name');
    expect(results).toHaveLength(1);
  });

  it('finds places regardless of their original source (e.g. an imported one)', async () => {
    await createPlace(t.travellog, ctx, {
      name: 'Imported Café',
      source: 'import',
      sourceRef: 'swarm-venue-1',
    });

    const provider = createManualPlaceProvider(t.travellog, ctx);
    const results = await provider.search('Imported');
    expect(results).toHaveLength(1);
  });

  it('sorts by distance when a current position is given, coordinate-less places last', async () => {
    const near = await createPlace(t.travellog, ctx, {
      name: 'Coffee Near',
      lat: 38.71,
      lng: -9.14,
      source: 'manual',
    });
    const far = await createPlace(t.travellog, ctx, {
      name: 'Coffee Far',
      lat: 41.16,
      lng: -8.63,
      source: 'manual',
    });
    const noCoords = await createPlace(t.travellog, ctx, {
      name: 'Coffee Unpinned',
      source: 'manual',
    });

    const provider = createManualPlaceProvider(t.travellog, ctx);
    const results = await provider.search('Coffee', { lat: 38.7071, lng: -9.1355 });

    expect(results.map((r) => r.existingPlaceId)).toEqual([near.id, far.id, noCoords.id]);
  });

  it('reverseGeocode always returns null — no coordinate-to-place lookup in phase 1', async () => {
    const provider = createManualPlaceProvider(t.travellog, ctx);
    expect(await provider.reverseGeocode(38.7071, -9.1355)).toBeNull();
  });
});
