/**
 * Itinerary item CRUD + reorder — one day's ordered plan. Unlike stops,
 * mutating an item never touches the trip's denormalized dates or its
 * day's own row; the only cross-cutting rule here (SPEC.md's Data model
 * notes) is `isFixed` only being meaningful — and only settable — alongside
 * a `plannedTime`.
 */
import { asc, desc, eq } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import {
  needsRenormalize,
  positionAfter,
  positionBetween,
  renormalizedPositions,
} from '../_db/position';
import { newId } from './ids';

export type ItineraryItemRow = typeof schema.itineraryItems.$inferSelect;

function assertValid(input: {
  placeId?: string | null;
  title?: string | null;
  plannedTime?: string | null;
  isFixed?: boolean;
}): void {
  if (!input.placeId && !input.title) {
    throw new Error('An itinerary item needs a place or a title.');
  }
  if (input.isFixed && !input.plannedTime) {
    throw new Error('Only a timed item can be marked fixed.');
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
  const [last] = await db
    .select({ position: schema.itineraryItems.position })
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.tripDayId, tripDayId))
    .orderBy(desc(schema.itineraryItems.position))
    .limit(1);

  await db.insert(schema.itineraryItems).values({
    id,
    tripDayId,
    tripId,
    placeId: input.placeId ?? null,
    title: input.title ?? null,
    plannedTime: input.plannedTime ?? null,
    isFixed: input.isFixed ? 1 : 0,
    position: positionAfter(last?.position),
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.id, id));
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
 */
export async function updateItineraryItem(
  db: TravellogDb,
  itemId: string,
  patch: UpdateItineraryItemInput,
): Promise<ItineraryItemRow> {
  const [current] = await db.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.id, itemId));
  if (!current) throw new Error('updateItineraryItem: item not found');

  assertValid({
    placeId: patch.placeId !== undefined ? patch.placeId : current.placeId,
    title: patch.title !== undefined ? patch.title : current.title,
    plannedTime: patch.plannedTime !== undefined ? patch.plannedTime : current.plannedTime,
    isFixed: patch.isFixed !== undefined ? patch.isFixed : Boolean(current.isFixed),
  });

  await db
    .update(schema.itineraryItems)
    .set({
      ...(patch.placeId !== undefined ? { placeId: patch.placeId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.plannedTime !== undefined ? { plannedTime: patch.plannedTime } : {}),
      ...(patch.isFixed !== undefined ? { isFixed: patch.isFixed ? 1 : 0 } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(schema.itineraryItems.id, itemId));

  const [row] = await db.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.id, itemId));
  if (!row) throw new Error('updateItineraryItem: row disappeared mid-update');
  return row;
}

export async function deleteItineraryItem(db: TravellogDb, itemId: string): Promise<void> {
  await db.delete(schema.itineraryItems).where(eq(schema.itineraryItems.id, itemId));
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

    const [row] = await tx.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.id, itemId));
    if (!row) throw new Error('reorderItineraryItem: row disappeared mid-reorder');
    return row;
  });
}

/** A day's items, ordered — `T.16`'s Planner day view reads through this. */
export async function listItineraryItems(db: TravellogDb, tripDayId: string): Promise<ItineraryItemRow[]> {
  return db
    .select()
    .from(schema.itineraryItems)
    .where(eq(schema.itineraryItems.tripDayId, tripDayId))
    .orderBy(asc(schema.itineraryItems.position));
}
