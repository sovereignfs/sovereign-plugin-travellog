/**
 * Stop CRUD + reorder — the most involved data layer in `T.11`, because
 * every mutation here has two side effects the caller never triggers
 * directly (SPEC.md's Data model notes):
 *
 * 1. Recomputing the owning trip's denormalized `startDate`/`endDate`
 *    (first stop's `arriveDate` → trip `startDate`; last stop's
 *    `departDate` → trip `endDate`, by `position` order).
 * 2. Syncing that stop's own `travellog_trip_days` rows to match its
 *    `arriveDate`/`departDate` range — added dates get a fresh row;
 *    dropped dates get their row deleted, **unless** it still has
 *    itinerary items, in which case the whole mutation is blocked
 *    (`TripDayHasItemsError`) rather than silently cascading the loss.
 *
 * Both happen inside the same transaction as the triggering stop write, so
 * a caller never observes a stop and its trip/day state disagreeing.
 */
import { asc, desc, eq } from 'drizzle-orm';
import type { TravellogDb, TravellogTx } from '../_db/client';
import * as schema from '../_db/schema';
import {
  needsRenormalize,
  positionAfter,
  positionBetween,
  renormalizedPositions,
} from '../_db/position';
import { recomputeAutoLinksForActor } from './auto-link';
import { compareDateKeys, enumerateDateKeys } from './dates';
import { newId } from './ids';

export type StopRow = typeof schema.stops.$inferSelect;

export class TripDayHasItemsError extends Error {
  constructor(public readonly blockedDates: string[]) {
    super(
      `Can't remove ${blockedDates.length === 1 ? 'this day' : 'these days'} — it still has planned items: ${blockedDates.join(', ')}.`,
    );
    this.name = 'TripDayHasItemsError';
  }
}

/**
 * Recomputes the trip's denormalized dates, then re-runs `T.12`'s auto-link
 * for the trip's *owner* (not just this one trip — a date-range change can
 * reshuffle which trip is "narrower" for a visit currently linked
 * elsewhere, so the recompute is actor-wide; see `./auto-link.ts`'s own
 * doc comment). Every stop mutation below calls this exactly once, after
 * its own writes — "for when a trip's stops change" (SPEC.md's `T.12`
 * deliverable) covers all four: create, update, delete, reorder.
 */
async function recomputeTripDatesAndAutoLinks(tx: TravellogTx, tripId: string): Promise<void> {
  const stops = await tx
    .select({ arriveDate: schema.stops.arriveDate, departDate: schema.stops.departDate })
    .from(schema.stops)
    .where(eq(schema.stops.tripId, tripId))
    .orderBy(asc(schema.stops.position));

  const first = stops[0];
  const last = stops[stops.length - 1];
  await tx
    .update(schema.trips)
    .set({
      startDate: first?.arriveDate ?? null,
      endDate: last?.departDate ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(schema.trips.id, tripId));

  const [trip] = await tx
    .select({ ownerId: schema.trips.ownerId, tenantId: schema.trips.tenantId })
    .from(schema.trips)
    .where(eq(schema.trips.id, tripId));
  if (trip) {
    await recomputeAutoLinksForActor(tx, { userId: trip.ownerId, tenantId: trip.tenantId });
  }
}

/**
 * Reconciles `stopId`'s `trip_day` rows against `[arriveDate, departDate]`.
 * Throws `TripDayHasItemsError` — leaving every row untouched — if any date
 * being dropped still has itinerary items, rather than partially applying
 * the safe half of the change.
 */
async function syncTripDaysForStop(
  tx: TravellogTx,
  stop: { id: string; tripId: string },
  arriveDate: string,
  departDate: string,
): Promise<void> {
  const desiredDates = new Set(enumerateDateKeys(arriveDate, departDate));
  const existing = await tx
    .select()
    .from(schema.tripDays)
    .where(eq(schema.tripDays.stopId, stop.id));
  const existingDates = new Set(existing.map((d) => d.date));

  const toRemove = existing.filter((d) => !desiredDates.has(d.date));
  const blockedDates: string[] = [];
  for (const day of toRemove) {
    const [item] = await tx
      .select({ id: schema.itineraryItems.id })
      .from(schema.itineraryItems)
      .where(eq(schema.itineraryItems.tripDayId, day.id))
      .limit(1);
    if (item) blockedDates.push(day.date);
  }
  if (blockedDates.length > 0) {
    throw new TripDayHasItemsError(blockedDates.sort());
  }

  for (const day of toRemove) {
    await tx.delete(schema.tripDays).where(eq(schema.tripDays.id, day.id));
  }
  const now = Date.now();
  for (const date of desiredDates) {
    if (!existingDates.has(date)) {
      await tx.insert(schema.tripDays).values({
        id: newId(),
        stopId: stop.id,
        tripId: stop.tripId,
        date,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

export interface CreateStopInput {
  placeId: string;
  arriveDate: string;
  departDate: string;
}

/** Always appends — the Planner's "Add a stop" affordance is at the end; reordering is a separate action. */
export async function createStop(
  db: TravellogDb,
  tripId: string,
  input: CreateStopInput,
): Promise<StopRow> {
  if (compareDateKeys(input.arriveDate, input.departDate) > 0) {
    throw new Error('A stop can’t depart before it arrives.');
  }
  const id = newId();
  const now = Date.now();

  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ position: schema.stops.position })
      .from(schema.stops)
      .where(eq(schema.stops.tripId, tripId))
      .orderBy(desc(schema.stops.position))
      .limit(1);
    const position = positionAfter(last?.position);

    await tx.insert(schema.stops).values({
      id,
      tripId,
      placeId: input.placeId,
      arriveDate: input.arriveDate,
      departDate: input.departDate,
      position,
      createdAt: now,
      updatedAt: now,
    });

    for (const date of enumerateDateKeys(input.arriveDate, input.departDate)) {
      await tx.insert(schema.tripDays).values({
        id: newId(),
        stopId: id,
        tripId,
        date,
        createdAt: now,
        updatedAt: now,
      });
    }

    await recomputeTripDatesAndAutoLinks(tx, tripId);

    const [row] = await tx.select().from(schema.stops).where(eq(schema.stops.id, id));
    if (!row) throw new Error('createStop: insert did not return a row');
    return row;
  });
}

export interface UpdateStopInput {
  placeId?: string;
  arriveDate?: string;
  departDate?: string;
}

/**
 * The caller (`../actions.ts`) resolves ownership first, same
 * trusts-the-caller contract as `./visits.ts`'s `updateVisit`. Throws
 * `TripDayHasItemsError` if shrinking the date range would drop a day that
 * still has itinerary items — nothing is written in that case.
 */
export async function updateStop(
  db: TravellogDb,
  tripId: string,
  stopId: string,
  patch: UpdateStopInput,
): Promise<StopRow> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.stops).where(eq(schema.stops.id, stopId));
    if (!current) throw new Error('updateStop: stop not found');

    const newArrive = patch.arriveDate ?? current.arriveDate;
    const newDepart = patch.departDate ?? current.departDate;
    if (compareDateKeys(newArrive, newDepart) > 0) {
      throw new Error('A stop can’t depart before it arrives.');
    }

    if (patch.arriveDate !== undefined || patch.departDate !== undefined) {
      await syncTripDaysForStop(tx, { id: stopId, tripId }, newArrive, newDepart);
    }

    await tx
      .update(schema.stops)
      .set({
        ...(patch.placeId !== undefined ? { placeId: patch.placeId } : {}),
        ...(patch.arriveDate !== undefined ? { arriveDate: patch.arriveDate } : {}),
        ...(patch.departDate !== undefined ? { departDate: patch.departDate } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(schema.stops.id, stopId));

    await recomputeTripDatesAndAutoLinks(tx, tripId);

    const [row] = await tx.select().from(schema.stops).where(eq(schema.stops.id, stopId));
    if (!row) throw new Error('updateStop: row disappeared mid-update');
    return row;
  });
}

/**
 * Throws `TripDayHasItemsError` instead of relying on the DB's own
 * `itinerary_items` restrict to surface a raw FK error — pre-checking gives
 * a clear, specific message (which dates are blocking) instead of a
 * generic constraint failure.
 */
export async function deleteStop(db: TravellogDb, tripId: string, stopId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const days = await tx
      .select({ id: schema.tripDays.id, date: schema.tripDays.date })
      .from(schema.tripDays)
      .where(eq(schema.tripDays.stopId, stopId));

    const blockedDates: string[] = [];
    for (const day of days) {
      const [item] = await tx
        .select({ id: schema.itineraryItems.id })
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.tripDayId, day.id))
        .limit(1);
      if (item) blockedDates.push(day.date);
    }
    if (blockedDates.length > 0) {
      throw new TripDayHasItemsError(blockedDates.sort());
    }

    await tx.delete(schema.stops).where(eq(schema.stops.id, stopId));
    await recomputeTripDatesAndAutoLinks(tx, tripId);
  });
}

/**
 * `targetIndex` is 0-based, within the trip's stop list **excluding** the
 * moved stop — i.e. where it should land among its new neighbours. Reuses
 * `_db/position.ts`'s fractional-position helpers (the same pattern
 * `sovereign-plugin-kanban` uses); renormalizes the whole sequence in the
 * rare case repeated midpoint insertion has exhausted the available gap.
 */
export async function reorderStop(
  db: TravellogDb,
  tripId: string,
  stopId: string,
  targetIndex: number,
): Promise<StopRow> {
  return db.transaction(async (tx) => {
    const stops = await tx
      .select()
      .from(schema.stops)
      .where(eq(schema.stops.tripId, tripId))
      .orderBy(asc(schema.stops.position));

    const moved = stops.find((s) => s.id === stopId);
    if (!moved) throw new Error('reorderStop: stop not found');

    const others = stops.filter((s) => s.id !== stopId);
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
          .update(schema.stops)
          .set({ position, updatedAt: Date.now() })
          .where(eq(schema.stops.id, target.id));
      }
    } else {
      const position = positionBetween(prev?.position, next?.position);
      await tx
        .update(schema.stops)
        .set({ position, updatedAt: Date.now() })
        .where(eq(schema.stops.id, stopId));
    }

    await recomputeTripDatesAndAutoLinks(tx, tripId);

    const [row] = await tx.select().from(schema.stops).where(eq(schema.stops.id, stopId));
    if (!row) throw new Error('reorderStop: row disappeared mid-reorder');
    return row;
  });
}

/** All of a trip's stops, ordered — `T.15`'s Planner strip reads through this. */
export async function listStops(db: TravellogDb, tripId: string): Promise<StopRow[]> {
  return db.select().from(schema.stops).where(eq(schema.stops.tripId, tripId)).orderBy(asc(schema.stops.position));
}

/** All of a stop's trip days, ordered by date. */
export async function listTripDays(
  db: TravellogDb,
  stopId: string,
): Promise<(typeof schema.tripDays.$inferSelect)[]> {
  return db
    .select()
    .from(schema.tripDays)
    .where(eq(schema.tripDays.stopId, stopId))
    .orderBy(asc(schema.tripDays.date));
}
