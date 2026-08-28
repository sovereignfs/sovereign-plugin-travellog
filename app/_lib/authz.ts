/**
 * Per-resource authorization. Every server action starts with
 * `requireUser()` (session) and then the relevant resource check — the
 * middleware's route gating is never sufficient for a server action, which
 * is a public POST endpoint dispatched by action id. Same pattern as
 * `sovereign-plugin-kanban`'s `_lib/authz.ts`, simplified: a visit has no
 * membership model, only a single owner (SPEC.md's "Hard platform rules").
 * Trips don't have a membership model either, as of `T.10`/`T.11` — real
 * shared access (`travellog_trip_members`) was never built, since
 * CONCEPT.md's open question 2 was still unresolved when `T.10` shipped
 * (see that task's `SPEC.md` status entry); a trip has exactly one owner,
 * same as a visit.
 *
 * A stop, trip day, or itinerary item has no `userId`/`ownerId` of its
 * own — ownership is always resolved transitively through the trip it
 * belongs to (an inner join, below), never duplicated onto every child
 * table.
 *
 * Denials deliberately read as "not found": whether a resource exists is
 * itself ownership-gated information — a non-owner gets the same `null`
 * whether the id belongs to someone else or doesn't exist at all.
 */
import { sdk } from '@sovereignfs/sdk';
import { and, eq } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';

export interface Actor {
  userId: string;
  tenantId: string;
}

export async function requireUser(): Promise<Actor> {
  const session = await sdk.auth.requireSession();
  return { userId: session.user.id, tenantId: session.user.tenantId };
}

export type VisitRow = typeof schema.visits.$inferSelect;

/** The visit, only if the actor owns it (and it's in their tenant) — null otherwise. */
export async function requireVisitOwner(
  db: TravellogDb,
  visitId: string,
  actor: Actor,
): Promise<VisitRow | null> {
  const rows = await db
    .select()
    .from(schema.visits)
    .where(
      and(
        eq(schema.visits.id, visitId),
        eq(schema.visits.userId, actor.userId),
        eq(schema.visits.tenantId, actor.tenantId),
      ),
    );
  return rows[0] ?? null;
}

export type TripRow = typeof schema.trips.$inferSelect;
export type StopRow = typeof schema.stops.$inferSelect;
export type TripDayRow = typeof schema.tripDays.$inferSelect;
export type ItineraryItemRow = typeof schema.itineraryItems.$inferSelect;
export type AttachmentRow = typeof schema.attachments.$inferSelect;

/** The trip, only if the actor owns it (and it's in their tenant) — null otherwise. */
export async function requireTripOwner(
  db: TravellogDb,
  tripId: string,
  actor: Actor,
): Promise<TripRow | null> {
  const rows = await db
    .select()
    .from(schema.trips)
    .where(
      and(
        eq(schema.trips.id, tripId),
        eq(schema.trips.ownerId, actor.userId),
        eq(schema.trips.tenantId, actor.tenantId),
      ),
    );
  return rows[0] ?? null;
}

/** The stop, only if the actor owns the trip it belongs to — null otherwise. */
export async function requireStopOwner(
  db: TravellogDb,
  stopId: string,
  actor: Actor,
): Promise<StopRow | null> {
  const rows = await db
    .select({ stop: schema.stops })
    .from(schema.stops)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.stops.tripId))
    .where(
      and(
        eq(schema.stops.id, stopId),
        eq(schema.trips.ownerId, actor.userId),
        eq(schema.trips.tenantId, actor.tenantId),
      ),
    );
  return rows[0]?.stop ?? null;
}

/** The trip day, only if the actor owns the trip it belongs to — null otherwise. */
export async function requireTripDayOwner(
  db: TravellogDb,
  tripDayId: string,
  actor: Actor,
): Promise<TripDayRow | null> {
  const rows = await db
    .select({ day: schema.tripDays })
    .from(schema.tripDays)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.tripDays.tripId))
    .where(
      and(
        eq(schema.tripDays.id, tripDayId),
        eq(schema.trips.ownerId, actor.userId),
        eq(schema.trips.tenantId, actor.tenantId),
      ),
    );
  return rows[0]?.day ?? null;
}

/** The itinerary item, only if the actor owns the trip it belongs to — null otherwise. */
export async function requireItineraryItemOwner(
  db: TravellogDb,
  itemId: string,
  actor: Actor,
): Promise<ItineraryItemRow | null> {
  const rows = await db
    .select({ item: schema.itineraryItems })
    .from(schema.itineraryItems)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.itineraryItems.tripId))
    .where(
      and(
        eq(schema.itineraryItems.id, itemId),
        eq(schema.trips.ownerId, actor.userId),
        eq(schema.trips.tenantId, actor.tenantId),
      ),
    );
  return rows[0]?.item ?? null;
}

/**
 * The attachment, only if the actor owns the trip it belongs to — null
 * otherwise. Resolves ownership through whichever of `tripId`/`tripDayId`
 * is actually set (`_lib/attachments.ts`'s `validateAttachmentTarget`
 * guarantees exactly one is), rather than assuming which one.
 */
export async function requireAttachmentOwner(
  db: TravellogDb,
  attachmentId: string,
  actor: Actor,
): Promise<AttachmentRow | null> {
  const [attachment] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId));
  if (!attachment) return null;

  const owned = attachment.tripId
    ? await requireTripOwner(db, attachment.tripId, actor)
    : attachment.tripDayId
      ? await requireTripDayOwner(db, attachment.tripDayId, actor)
      : null;
  return owned ? attachment : null;
}
