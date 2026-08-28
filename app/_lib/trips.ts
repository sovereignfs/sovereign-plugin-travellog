/**
 * Trip CRUD — the mutation data layer; `../actions.ts` wraps these with
 * `requireUser()`/`requireTripOwner()` and `ActionResult`. Stop/itinerary
 * CRUD live in their own `./stops.ts`/`./itinerary-items.ts`, since each
 * touches its own transaction and recompute logic.
 */
import { eq } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import type { Actor } from './authz';
import { newId } from './ids';

export type TripRow = typeof schema.trips.$inferSelect;

/**
 * A trip starts with just a name — no date-range field (SPEC.md's T.11
 * deliverables: "create just takes a name"). `startDate`/`endDate` are a
 * denormalized cache derived from stops (`./stops.ts` recomputes them);
 * there is nothing to set here until the first stop exists.
 */
export async function createTrip(db: TravellogDb, actor: Actor, name: string): Promise<TripRow> {
  const now = Date.now();
  const id = newId();

  await db.insert(schema.trips).values({
    id,
    tenantId: actor.tenantId,
    ownerId: actor.userId,
    name,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(schema.trips).where(eq(schema.trips.id, id));
  if (!row) throw new Error('createTrip: insert did not return a row');
  return row;
}

export interface UpdateTripInput {
  name?: string;
  timezone?: string | null;
  /** Lightweight, informational tags — see schema.ts's header comment on why there's no real trip_members table. */
  companions?: string[];
}

/**
 * Deliberately no `startDate`/`endDate` in this input — those are only
 * ever written by `./stops.ts`'s recompute, never directly by a caller.
 * The trusts-the-caller-already-checked-ownership contract matches
 * `./visits.ts`'s `updateVisit`.
 */
export async function updateTrip(
  db: TravellogDb,
  tripId: string,
  patch: UpdateTripInput,
): Promise<TripRow> {
  const now = Date.now();
  await db
    .update(schema.trips)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.companions !== undefined
        ? { companions: patch.companions.length > 0 ? JSON.stringify(patch.companions) : null }
        : {}),
      updatedAt: now,
    })
    .where(eq(schema.trips.id, tripId));

  const [row] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
  if (!row) throw new Error('updateTrip: row disappeared mid-update');
  return row;
}

/**
 * A whole-trip delete is a deliberate, complete removal — unlike
 * `itinerary_items`' `restrict` FKs (SPEC.md: don't silently cascade a
 * *single day's* removal out from under real planned content), a user who
 * explicitly deletes an entire trip does mean to take everything under it
 * with it. `restrict` on `itinerary_items.tripId`/`tripDayId` (`T.10`)
 * means a plain `DELETE FROM trips` would otherwise fail outright the
 * moment any itinerary item exists anywhere in the trip, so this clears
 * the blocking rows explicitly, in order, in one transaction:
 *
 * 1. Null every linked visit's `linkSource` — the trip's own FK
 *    (`onDelete: 'set null'`) will null `tripId` itself, but never touches
 *    `linkSource`, which must stay null iff `tripId` is null (`schema.ts`'s
 *    own comment on `visits.tripId`).
 * 2. Delete every `itinerary_item` row for this trip directly (by its
 *    denormalized `tripId`) — once these are gone, nothing blocks the
 *    `trips → stops → trip_days` cascade below.
 * 3. Delete the trip itself; `stops`/`trip_days` cascade automatically.
 */
export async function deleteTrip(db: TravellogDb, tripId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.visits)
      .set({ linkSource: null, updatedAt: Date.now() })
      .where(eq(schema.visits.tripId, tripId));
    await tx.delete(schema.itineraryItems).where(eq(schema.itineraryItems.tripId, tripId));
    await tx.delete(schema.trips).where(eq(schema.trips.id, tripId));
  });
}
