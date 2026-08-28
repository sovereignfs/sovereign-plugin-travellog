/**
 * Applies the real generated SQLite migrations (migrations/sqlite/, via
 * Drizzle's own migrator — journal and all) to an ephemeral database, then
 * exercises the schema through ../schema.ts: seed data, the import de-dup
 * unique constraint, and FK cascade/restrict behavior. This is the same
 * migration path the platform runs at startup, so a malformed journal or SQL
 * file fails here first — this is what SPEC.md's T.2 review checklist means
 * by "migrations run clean on a fresh dev DB."
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDemoData, SEED_PLACE_HOME_ID, type TravellogDb } from '../seed';
import * as schema from '../schema';
import { createTestDb, type TestDb } from './test-db';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

/** Narrow a possibly-undefined row (noUncheckedIndexedAccess) with a hard failure. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to exist`);
  return value;
}

/** Drizzle wraps the driver error with the SQLite constraint violation as its cause. */
async function captureConstraintError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return [error, (error as { cause?: unknown })?.cause]
    .map((e) => String((e as Error | undefined)?.message ?? ''))
    .join(' | ');
}

let t: TestDb;
let db: TestDb['db'];

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
});

afterEach(() => {
  t.close();
});

describe('travellog schema (real migrations, ephemeral sqlite)', () => {
  it('applies the migration folder cleanly and creates every table', async () => {
    const res = await t.client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'travellog_%'",
    );
    const tables = res.rows.map((r) => String(r.name)).sort();
    expect(tables).toEqual([
      'travellog_attachments',
      'travellog_import_jobs',
      'travellog_itinerary_items',
      'travellog_places',
      'travellog_stops',
      'travellog_trip_days',
      'travellog_trips',
      'travellog_visit_photos',
      'travellog_visits',
    ]);
  });

  it('seeds demo data idempotently', async () => {
    expect(await seedDemoData(db as unknown as TravellogDb, ctx)).toBe(true);
    expect(await seedDemoData(db as unknown as TravellogDb, ctx)).toBe(false);

    const places = await db.select().from(schema.places);
    expect(places).toHaveLength(3);
    expect(places.map((p) => p.id)).toContain(SEED_PLACE_HOME_ID);

    const visits = await db.select().from(schema.visits);
    expect(visits).toHaveLength(3);
    expect(new Set(visits.map((v) => v.userId))).toEqual(new Set([ctx.userId]));

    const photos = await db.select().from(schema.visitPhotos);
    expect(photos).toHaveLength(1);
  });

  it('rejects a duplicate (tenant_id, source, external_ref) — import de-dup', async () => {
    const now = Date.now();
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const base = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      placeId: SEED_PLACE_HOME_ID,
      happenedAt: now,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'import:swarm',
      externalRef: 'swarm-checkin-123',
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(schema.visits).values({ ...base, id: 'import-1' });

    const chain = await captureConstraintError(
      db.insert(schema.visits).values({ ...base, id: 'import-1-retry' }),
    );
    expect(chain).toMatch(/UNIQUE/i);

    // Re-running the same import elsewhere (different source/ref) is unaffected.
    await db.insert(schema.visits).values({
      ...base,
      id: 'import-2',
      externalRef: 'swarm-checkin-456',
    });
    expect(await db.select().from(schema.visits)).toHaveLength(5); // 3 seeded + import-1 + import-2
  });

  it('cascades a visit delete through its photos', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const visitWithPhoto = must(
      (
        await db
          .select()
          .from(schema.visits)
          .innerJoin(schema.visitPhotos, eq(schema.visitPhotos.visitId, schema.visits.id))
      )[0],
      'seed visit with photo',
    );

    await db.delete(schema.visits).where(eq(schema.visits.id, visitWithPhoto.travellog_visits.id));

    expect(await db.select().from(schema.visitPhotos)).toHaveLength(0);
    // The place itself survives — visits cascade down, not up.
    expect(await db.select().from(schema.places)).toHaveLength(3);
  });

  it('restricts deleting a place that still has visits (FK enforced)', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);

    const chain = await captureConstraintError(
      db.delete(schema.places).where(eq(schema.places.id, SEED_PLACE_HOME_ID)),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);

    // Nothing was removed — the restrict failed the whole statement.
    expect(await db.select().from(schema.places)).toHaveLength(3);
  });

  it('rejects a visit pointing at a missing place (FK enforced)', async () => {
    const now = Date.now();
    const chain = await captureConstraintError(
      db.insert(schema.visits).values({
        id: 'orphan-visit',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        placeId: 'no-such-place',
        happenedAt: now,
        tzIana: 'Europe/Lisbon',
        tzOffsetMinutes: 60,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      }),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);
  });
});

/** A minimal trip → stop → day → itinerary-item chain, all real inserts. */
async function seedTripChain(
  db: TestDb['db'],
  placeId: string,
  overrides?: { itineraryItem?: boolean },
): Promise<{ tripId: string; stopId: string; dayId: string; itemId?: string }> {
  const now = Date.now();
  const tripId = 'trip-1';
  const stopId = 'stop-1';
  const dayId = 'day-1';

  await db.insert(schema.trips).values({
    id: tripId,
    tenantId: ctx.tenantId,
    ownerId: ctx.userId,
    name: 'Portugal',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.stops).values({
    id: stopId,
    tripId,
    placeId,
    arriveDate: '2026-09-01',
    departDate: '2026-09-03',
    position: 1024,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.tripDays).values({
    id: dayId,
    stopId,
    tripId,
    date: '2026-09-01',
    createdAt: now,
    updatedAt: now,
  });

  if (!overrides?.itineraryItem) return { tripId, stopId, dayId };

  const itemId = 'item-1';
  await db.insert(schema.itineraryItems).values({
    id: itemId,
    tripDayId: dayId,
    tripId,
    placeId,
    position: 1024,
    isFixed: 0,
    createdAt: now,
    updatedAt: now,
  });
  return { tripId, stopId, dayId, itemId };
}

describe('T.10 — trip/stop/itinerary schema (real migrations, ephemeral sqlite)', () => {
  it('inserts a full trip → stop → day → itinerary-item chain', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { tripId, stopId, itemId } = await seedTripChain(db, SEED_PLACE_HOME_ID, {
      itineraryItem: true,
    });

    expect(await db.select().from(schema.trips)).toHaveLength(1);
    expect((await db.select().from(schema.stops))[0]?.tripId).toBe(tripId);
    expect((await db.select().from(schema.tripDays))[0]?.stopId).toBe(stopId);
    expect((await db.select().from(schema.itineraryItems))[0]?.id).toBe(itemId);
  });

  it('cascades a trip delete through its stops', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { tripId } = await seedTripChain(db, SEED_PLACE_HOME_ID);

    await db.delete(schema.trips).where(eq(schema.trips.id, tripId));

    expect(await db.select().from(schema.stops)).toHaveLength(0);
    expect(await db.select().from(schema.tripDays)).toHaveLength(0);
  });

  it('cascades a stop delete through its trip days (when no itinerary items exist)', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { stopId } = await seedTripChain(db, SEED_PLACE_HOME_ID);

    await db.delete(schema.stops).where(eq(schema.stops.id, stopId));

    expect(await db.select().from(schema.tripDays)).toHaveLength(0);
  });

  it('restricts deleting a trip day that still has itinerary items — not silently cascaded', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { dayId } = await seedTripChain(db, SEED_PLACE_HOME_ID, { itineraryItem: true });

    const chain = await captureConstraintError(
      db.delete(schema.tripDays).where(eq(schema.tripDays.id, dayId)),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);
    expect(await db.select().from(schema.itineraryItems)).toHaveLength(1);
  });

  it('restricts deleting a stop whose day still has itinerary items — the restrict blocks the whole cascade chain', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { stopId } = await seedTripChain(db, SEED_PLACE_HOME_ID, { itineraryItem: true });

    const chain = await captureConstraintError(
      db.delete(schema.stops).where(eq(schema.stops.id, stopId)),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);
    expect(await db.select().from(schema.tripDays)).toHaveLength(1);
    expect(await db.select().from(schema.itineraryItems)).toHaveLength(1);
  });

  it('restricts deleting a trip that still has itinerary items — the denormalized tripId FK blocks it directly', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { tripId } = await seedTripChain(db, SEED_PLACE_HOME_ID, { itineraryItem: true });

    const chain = await captureConstraintError(
      db.delete(schema.trips).where(eq(schema.trips.id, tripId)),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);
    expect(await db.select().from(schema.trips)).toHaveLength(1);
  });

  it('restricts deleting a place that still has an active stop', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    await seedTripChain(db, SEED_PLACE_HOME_ID);

    const chain = await captureConstraintError(
      db.delete(schema.places).where(eq(schema.places.id, SEED_PLACE_HOME_ID)),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);
  });

  it('restricts deleting a place that an itinerary item still points at', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    // A second place with no stop of its own, referenced only by the itinerary item.
    const now = Date.now();
    await db.insert(schema.places).values({
      id: 'place-cafe',
      tenantId: ctx.tenantId,
      name: 'A café along the way',
      source: 'manual',
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    const { tripId, dayId } = await seedTripChain(db, SEED_PLACE_HOME_ID);
    await db.insert(schema.itineraryItems).values({
      id: 'item-cafe',
      tripDayId: dayId,
      tripId,
      placeId: 'place-cafe',
      position: 1024,
      isFixed: 0,
      createdAt: now,
      updatedAt: now,
    });

    const chain = await captureConstraintError(
      db.delete(schema.places).where(eq(schema.places.id, 'place-cafe')),
    );
    expect(chain).toMatch(/FOREIGN KEY/i);
  });

  it('rejects a duplicate (stop_id, date) trip day', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { stopId, tripId } = await seedTripChain(db, SEED_PLACE_HOME_ID);
    const now = Date.now();

    const chain = await captureConstraintError(
      db.insert(schema.tripDays).values({
        id: 'day-1-dup',
        stopId,
        tripId,
        date: '2026-09-01', // same (stopId, date) as seedTripChain's own day-1
        createdAt: now,
        updatedAt: now,
      }),
    );
    expect(chain).toMatch(/UNIQUE/i);
  });

  it('nulls a visit’s tripId when its trip is hard-deleted, but does not touch linkSource on its own', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { tripId } = await seedTripChain(db, SEED_PLACE_HOME_ID);
    const now = Date.now();

    await db.insert(schema.visits).values({
      id: 'linked-visit',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      placeId: SEED_PLACE_HOME_ID,
      happenedAt: now,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      tripId,
      linkSource: 'manual',
      createdAt: now,
      updatedAt: now,
    });

    await db.delete(schema.trips).where(eq(schema.trips.id, tripId));

    const visit = must(
      (await db.select().from(schema.visits).where(eq(schema.visits.id, 'linked-visit')))[0],
      'linked visit',
    );
    expect(visit.tripId).toBeNull();
    // Documented, deliberate gap (see schema.ts's own comment on visits.tripId):
    // a hard trip delete only nulls tripId via the FK — linkSource is left
    // stale until T.11's trip-delete action explicitly clears it too.
    expect(visit.linkSource).toBe('manual');
  });

  it('does not enforce the attachments trip_id/trip_day_id XOR at the DB layer — that is _lib/attachments.ts’s job', async () => {
    await seedDemoData(db as unknown as TravellogDb, ctx);
    const { tripId, dayId } = await seedTripChain(db, SEED_PLACE_HOME_ID);
    const now = Date.now();

    // Both set — the schema allows it; validateAttachmentTarget is what rejects this.
    await db.insert(schema.attachments).values({
      id: 'attachment-both',
      tripId,
      tripDayId: dayId,
      kind: 'receipt',
      title: 'Both set (schema allows, app layer would reject)',
      storageKey: 'attachments/both.pdf',
      createdBy: ctx.userId,
      createdAt: now,
    });
    expect(await db.select().from(schema.attachments)).toHaveLength(1);
  });
});
