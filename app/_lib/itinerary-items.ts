/**
 * Itinerary item CRUD + reorder — one day's ordered plan. Unlike stops,
 * mutating an item never touches the trip's denormalized dates or its
 * day's own row; the only cross-cutting rules here (SPEC.md's Data model
 * notes) are `isFixed` only being meaningful — and only settable —
 * alongside a `plannedTime`, and `plannedTime` being a well-formed
 * zero-padded `"HH:mm"` (every comparison against it is a string compare,
 * which is only chronological for that exact shape).
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import {
  needsRenormalize,
  positionAfter,
  positionBetween,
  renormalizedPositions,
} from '../_db/position';
import { newId } from './ids';
import { isValidPlannedTime } from './validation';

export type ItineraryItemRow = typeof schema.itineraryItems.$inferSelect;

/** Every user-correctable rejection here — `actions.ts` surfaces exactly these as `fail(...)`, never a raw driver error. */
export class ItineraryItemValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItineraryItemValidationError';
  }
}

function assertValid(input: {
  placeId?: string | null;
  title?: string | null;
  plannedTime?: string | null;
  isFixed?: boolean;
}): void {
  if (!input.placeId && !(input.title && input.title.trim().length > 0)) {
    throw new ItineraryItemValidationError('An itinerary item needs a place or a title.');
  }
  if (input.plannedTime != null && !isValidPlannedTime(input.plannedTime)) {
    throw new ItineraryItemValidationError('A planned time must look like 14:30.');
  }
  if (input.isFixed && !input.plannedTime) {
    throw new ItineraryItemValidationError('Only a timed item can be marked fixed.');
  }
}

export interface CreateItineraryItemInput {
  /** Nullable — a title-only item (no resolved place) is schema-legal. */
  placeId?: string | null;
  /** Required if placeId is omitted/null. */
  title?: string | null;
  /** "HH:mm", nullable. */
  plannedTime?: string | null;
  isFixed?: boolean;
  notes?: string | null;
}

/** Always appends to the day — the caller (`../actions.ts`) resolves `tripDayId`'s ownership via its trip first. */
export async function createItineraryItem(
  db: TravellogDb,
  tripDayId: string,
  tripId: string,
  input: CreateItineraryItemInput,
): Promise<ItineraryItemRow> {
  assertValid(input);

  const id = newId();
  const now = Date.now();
  // Read-then-append inside one transaction — two concurrent appends
  // otherwise read the same last position and collide.
  await db.transaction(async (tx) => {
    const [trip] = await tx
      .select({ tenantId: schema.trips.tenantId })
      .from(schema.trips)
      .where(eq(schema.trips.id, tripId));
    if (!trip) throw new Error('createItineraryItem: trip not found');

    const [last] = await tx
      .select({ position: schema.itineraryItems.position })
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.tripDayId, tripDayId))
      .orderBy(desc(schema.itineraryItems.position))
      .limit(1);

    await tx.insert(schema.itineraryItems).values({
      id,
      tenantId: trip.tenantId,
      tripDayId,
      tripId,
      placeId: input.placeId ?? null,
      title: input.title?.trim() || null,
      plannedTime: input.plannedTime ?? null,
      isFixed: input.isFixed ? 1 : 0,
      position: positionAfter(last?.position),
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });
  });

  const [row] = await db
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.id, id));
  if (!row) throw new Error('createItineraryItem: insert did not return a row');
  return row;
}

export interface UpdateItineraryItemInput {
  placeId?: string | null;
  title?: string | null;
  plannedTime?: string | null;
  isFixed?: boolean;
  notes?: string | null;
}

/**
 * Validates the *resulting* state (existing row merged with the patch),
 * not the patch in isolation — e.g. patching only `isFixed: true` on an
 * item that already has a `plannedTime` is valid; the reverse (clearing
 * `plannedTime` on an already-fixed item without also clearing `isFixed`)
 * is not.
 *
 * A changed `plannedTime` re-arms the reminder (`reminderSentAt: null`):
 * the claim marker exists to fire once per *planned moment*, and moving an
 * item to a later time is a new moment — without the reset, an item
 * reminded at 09:40 for a 10:00 slot and then rescheduled to 18:00 would
 * silently never remind again.
 */
export async function updateItineraryItem(
  db: TravellogDb,
  itemId: string,
  patch: UpdateItineraryItemInput,
): Promise<ItineraryItemRow> {
  const [current] = await db
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.id, itemId));
  if (!current) throw new Error('updateItineraryItem: item not found');

  assertValid({
    placeId: patch.placeId !== undefined ? patch.placeId : current.placeId,
    title: patch.title !== undefined ? patch.title : current.title,
    plannedTime: patch.plannedTime !== undefined ? patch.plannedTime : current.plannedTime,
    isFixed: patch.isFixed !== undefined ? patch.isFixed : Boolean(current.isFixed),
  });

  const plannedTimeChanged =
    patch.plannedTime !== undefined && (patch.plannedTime ?? null) !== current.plannedTime;

  await db
    .update(schema.itineraryItems)
    .set({
      ...(patch.placeId !== undefined ? { placeId: patch.placeId } : {}),
      ...(patch.title !== undefined ? { title: patch.title?.trim() || null } : {}),
      ...(patch.plannedTime !== undefined ? { plannedTime: patch.plannedTime } : {}),
      ...(patch.isFixed !== undefined ? { isFixed: patch.isFixed ? 1 : 0 } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(plannedTimeChanged ? { reminderSentAt: null } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(schema.itineraryItems.id, itemId));

  const [row] = await db
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.id, itemId));
  if (!row) throw new Error('updateItineraryItem: row disappeared mid-update');
  return row;
}

export async function deleteItineraryItem(db: TravellogDb, itemId: string): Promise<void> {
  await db.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, itemId));
}

/**
 * Moves an item to a different day of the *same* trip, appended at the
 * end of that day. Same-trip is enforced here (not just by the caller's
 * authz, which only proves the actor owns both) because `tripId` is a
 * denormalized copy on the item and must keep agreeing with its day's.
 * The reminder claim is reset for the same reason as a time change: a new
 * day is a new planned moment.
 */
export async function moveItineraryItem(
  db: TravellogDb,
  itemId: string,
  targetTripDayId: string,
): Promise<ItineraryItemRow> {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, itemId));
    if (!item) throw new Error('moveItineraryItem: item not found');
    if (item.tripDayId === targetTripDayId) return;

    const [day] = await tx
      .select({ tripId: schema.tripDays.tripId })
      .from(schema.tripDays)
      .where(eq(schema.tripDays.id, targetTripDayId));
    if (!day || day.tripId !== item.tripId) {
      throw new ItineraryItemValidationError(
        'An activity can only move to another day of the same trip.',
      );
    }

    const [last] = await tx
      .select({ position: schema.itineraryItems.position })
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.tripDayId, targetTripDayId))
      .orderBy(desc(schema.itineraryItems.position))
      .limit(1);

    await tx
      .update(schema.itineraryItems)
      .set({
        tripDayId: targetTripDayId,
        position: positionAfter(last?.position),
        reminderSentAt: null,
        updatedAt: Date.now(),
      })
      .where(eq(schema.itineraryItems.id, itemId));
  });

  const [row] = await db
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.id, itemId));
  if (!row) throw new Error('moveItineraryItem: row disappeared mid-move');
  return row;
}

/** `targetIndex` is 0-based within the day's item list, excluding the moved item. Same pattern as `./stops.ts`'s `reorderStop`. */
export async function reorderItineraryItem(
  db: TravellogDb,
  tripDayId: string,
  itemId: string,
  targetIndex: number,
): Promise<ItineraryItemRow> {
  return db.transaction(async (tx) => {
    const items = await tx
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.tripDayId, tripDayId))
      .orderBy(asc(schema.itineraryItems.position));

    const moved = items.find((item) => item.id === itemId);
    if (!moved) throw new Error('reorderItineraryItem: item not found');

    const others = items.filter((item) => item.id !== itemId);
    const clampedIndex = Math.max(0, Math.min(targetIndex, others.length));
    const prev = others[clampedIndex - 1];
    const next = others[clampedIndex];

    if (needsRenormalize(prev?.position, next?.position)) {
      const ordered = [...others.slice(0, clampedIndex), moved, ...others.slice(clampedIndex)];
      const positions = renormalizedPositions(ordered.length);
      for (let i = 0; i < ordered.length; i++) {
        const target = ordered[i];
        const position = positions[i];
        if (!target || position === undefined) continue;
        await tx
          .update(schema.itineraryItems)
          .set({ position, updatedAt: Date.now() })
          .where(eq(schema.itineraryItems.id, target.id));
      }
    } else {
      const position = positionBetween(prev?.position, next?.position);
      await tx
        .update(schema.itineraryItems)
        .set({ position, updatedAt: Date.now() })
        .where(eq(schema.itineraryItems.id, itemId));
    }

    const [row] = await tx
      .select()
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.id, itemId));
    if (!row) throw new Error('reorderItineraryItem: row disappeared mid-reorder');
    return row;
  });
}

/** A day's items, ordered — `T.16`'s Planner day view reads through this. */
export async function listItineraryItems(
  db: TravellogDb,
  tripDayId: string,
): Promise<ItineraryItemRow[]> {
  return db
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.tripDayId, tripDayId))
    .orderBy(asc(schema.itineraryItems.position));
}

/**
 * `T.20` — claims an item for a reminder send via a conditional update, the
 * "claim before acting" idempotency `schedules` handlers require
 * (`docs/plugin-development.md`: ticks can overlap a restart or a
 * multi-replica deployment, and Phase 1 schedules have no persistence of
 * their own). Returns whether *this* call won the claim — `false` means
 * another tick already claimed it, so the caller must not send a second
 * notification.
 *
 * Confirms via a select-back rather than a driver-reported affected-row
 * count — the same idiom every other write in this file already uses
 * (`createTrip`/`updateItineraryItem`/etc.'s "select back to confirm"), and
 * the honest one here specifically: `TravellogDb` is typed as
 * `BaseSQLiteDatabase` even on Postgres (`_db/client.ts`), so a raw rowcount
 * isn't guaranteed portable across both dialects the way a plain `select`
 * always is.
 */
export async function claimReminderForItem(
  db: TravellogDb,
  itemId: string,
  claimedAtUtcMs: number,
): Promise<boolean> {
  await db
    .update(schema.itineraryItems)
    .set({ reminderSentAt: claimedAtUtcMs })
    .where(and(eq(schema.itineraryItems.id, itemId), isNull(schema.itineraryItems.reminderSentAt)));

  const [row] = await db
    .select({ reminderSentAt: schema.itineraryItems.reminderSentAt })
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.id, itemId));

  return row?.reminderSentAt === claimedAtUtcMs;
}

/**
 * Releases a claim this tick made but could not act on (the notification
 * send threw). Conditional on the claim value so a claim won by a *later*
 * tick is never released by an earlier one's failure path.
 */
export async function releaseReminderClaim(
  db: TravellogDb,
  itemId: string,
  claimedAtUtcMs: number,
): Promise<void> {
  await db
    .update(schema.itineraryItems)
    .set({ reminderSentAt: null })
    .where(
      and(
        eq(schema.itineraryItems.id, itemId),
        eq(schema.itineraryItems.reminderSentAt, claimedAtUtcMs),
      ),
    );
}
