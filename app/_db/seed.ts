/**
 * Dev seed — a handful of demo places and check-ins for local development.
 *
 * Pure data-layer helper: takes any Drizzle client bound to this plugin's
 * schema (the SDK boundary forbids reaching into `@sovereignfs/db` from
 * plugin code, so acquiring the client is the caller's job — a dev-gated
 * server action, or the in-memory test DB). Idempotent: no-ops when the
 * seed place already exists. Same pattern as `sovereign-plugin-kanban`'s
 * `_db/seed.ts`.
 */
import { sdk } from '@sovereignfs/sdk';
import { eq } from 'drizzle-orm';
import type { TravellogDb } from './client';
import { positionAfter } from './position';
import * as schema from './schema';

export type { TravellogDb } from './client';

export const SEED_PLACE_HOME_ID = 'seed-place-home-cafe';

export interface SeedContext {
  tenantId: string;
  userId: string;
}

export async function seedDemoData(db: TravellogDb, ctx: SeedContext): Promise<boolean> {
  const existing = await db
    .select({ id: schema.places.id })
    .from(schema.places)
    .where(eq(schema.places.id, SEED_PLACE_HOME_ID));
  if (existing.length > 0) return false;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const seedPlaces = [
    {
      id: SEED_PLACE_HOME_ID,
      name: 'Corvo Coffee Roasters',
      category: 'Café',
      lat: 38.7071,
      lng: -9.1355,
      city: 'Lisbon',
      country: 'Portugal',
      countryCode: 'PT',
    },
    {
      id: 'seed-place-belem-tower',
      name: 'Belém Tower',
      category: 'Landmark',
      lat: 38.6916,
      lng: -9.2159,
      city: 'Lisbon',
      country: 'Portugal',
      countryCode: 'PT',
    },
    {
      id: 'seed-place-time-out-market',
      name: 'Time Out Market',
      category: 'Food hall',
      lat: 38.7069,
      lng: -9.1457,
      city: 'Lisbon',
      country: 'Portugal',
      countryCode: 'PT',
    },
  ];

  for (const place of seedPlaces) {
    await db.insert(schema.places).values({
      ...place,
      tenantId: ctx.tenantId,
      source: 'manual',
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
  }

  const seedVisits = [
    { placeId: SEED_PLACE_HOME_ID, daysAgo: 0, note: null },
    { placeId: 'seed-place-belem-tower', daysAgo: 1, note: 'Long line, worth it for the view.' },
    { placeId: 'seed-place-time-out-market', daysAgo: 1, note: null },
  ];

  let photoPosition: number | undefined;
  for (const [i, visit] of seedVisits.entries()) {
    const happenedAt = now - visit.daysAgo * day;
    const visitId = `seed-visit-${i}`;
    const sealed = await sdk.crypto.seal(schema.visits, {
      id: visitId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      placeId: visit.placeId,
      happenedAt,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: visit.note,
      source: 'manual',
      createdAt: happenedAt,
      updatedAt: happenedAt,
    });
    await db.insert(schema.visits).values(sealed);
    if (i === 0) {
      photoPosition = positionAfter(photoPosition);
      await db.insert(schema.visitPhotos).values({
        id: 'seed-visit-photo-0',
        visitId,
        storageKey: 'seed/placeholder.jpg',
        position: photoPosition,
        source: 'upload',
        createdAt: happenedAt,
      });
    }
  }

  return true;
}
