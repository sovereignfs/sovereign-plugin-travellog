import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createPlace, findOrCreateImportedPlace } from '../places';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

describe('createPlace', () => {
  it('creates a place with full fields', async () => {
    const place = await createPlace(t.travellog, ctx, {
      name: 'Belém Tower',
      category: 'Landmark',
      lat: 38.6916,
      lng: -9.2159,
      city: 'Lisbon',
      country: 'Portugal',
      countryCode: 'PT',
      source: 'manual',
    });

    expect(place.name).toBe('Belém Tower');
    expect(place.lat).toBe(38.6916);
    expect(place.tenantId).toBe(ctx.tenantId);
    expect(place.createdBy).toBe(ctx.userId);

    const [row] = await t.db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row).toEqual(place);
  });

  it('allows creating a place with no coordinates — does not default to 0/0', async () => {
    const place = await createPlace(t.travellog, ctx, {
      name: 'My Local Café',
      source: 'manual',
    });

    expect(place.lat).toBeNull();
    expect(place.lng).toBeNull();

    // Doesn't break a subsequent read.
    const [row] = await t.db.select().from(schema.places).where(eq(schema.places.id, place.id));
    expect(row?.lat).toBeNull();
    expect(row?.lng).toBeNull();
  });

  it('scopes places to their tenant', async () => {
    const mine = await createPlace(t.travellog, ctx, { name: 'Mine', source: 'manual' });
    const theirs = await createPlace(
      t.travellog,
      { tenantId: 'tenant-2', userId: 'user-2' },
      { name: 'Theirs', source: 'manual' },
    );

    expect(mine.tenantId).toBe('tenant-1');
    expect(theirs.tenantId).toBe('tenant-2');
  });
});

describe('findOrCreateImportedPlace (T.8)', () => {
  it('creates a new place with source "import" when no sourceRef match exists', async () => {
    const place = await findOrCreateImportedPlace(t.travellog, ctx, {
      name: 'Corvo Coffee Roasters',
      sourceRef: 'venue-1',
    });
    expect(place.source).toBe('import');
    expect(place.sourceRef).toBe('venue-1');
  });

  it('reuses the existing place for the same sourceRef instead of creating a duplicate', async () => {
    const first = await findOrCreateImportedPlace(t.travellog, ctx, {
      name: 'Corvo Coffee Roasters',
      sourceRef: 'venue-1',
    });
    const second = await findOrCreateImportedPlace(t.travellog, ctx, {
      name: 'Corvo Coffee Roasters',
      sourceRef: 'venue-1',
    });
    expect(second.id).toBe(first.id);

    const rows = await t.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.sourceRef, 'venue-1'));
    expect(rows).toHaveLength(1);
  });

  it('does not match a manually-created place that happens to share a name', async () => {
    await createPlace(t.travellog, ctx, { name: 'Corvo Coffee Roasters', source: 'manual' });
    const imported = await findOrCreateImportedPlace(t.travellog, ctx, {
      name: 'Corvo Coffee Roasters',
      sourceRef: 'venue-1',
    });
    expect(imported.source).toBe('import');

    const rows = await t.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.name, 'Corvo Coffee Roasters'));
    expect(rows).toHaveLength(2);
  });

  it('creates a fresh place every time when sourceRef is absent, never matching', async () => {
    const first = await findOrCreateImportedPlace(t.travellog, ctx, { name: 'No Venue Id' });
    const second = await findOrCreateImportedPlace(t.travellog, ctx, { name: 'No Venue Id' });
    expect(first.id).not.toBe(second.id);
  });
});
