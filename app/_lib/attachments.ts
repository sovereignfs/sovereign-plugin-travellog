/**
 * `T.10`'s own review checklist: "app-layer check enforces exactly one of
 * `attachments.trip_id`/`trip_day_id` set (covered by a unit test, not just
 * a comment)." The schema leaves both columns nullable (SPEC.md's Data
 * model section) rather than a DB `CHECK` constraint — `validateAttachmentTarget`
 * is what `createAttachment`, below, calls before writing.
 *
 * The actual file bytes live in `sdk.storage`, never here — a receipt or
 * booking confirmation routinely exceeds Next's 1 MB server-action body
 * cap, so the upload itself is a Route Handler
 * (`app/(home)/trips/attachments/upload/route.ts`), same precedent as
 * `T.7`'s photo upload and `T.8`'s ZIP upload: the client uploads there
 * first and gets back a `storageKey`, then calls `createAttachment` (via
 * `../actions.ts`) with that key. `createAttachment` itself only writes the
 * DB row — it never touches `sdk.storage`, so it stays trivially testable
 * against a plain ephemeral DB like every other data-layer function here.
 */
import { asc, eq, inArray, or } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import { newId } from './ids';

export type AttachmentRow = typeof schema.attachments.$inferSelect;
export type AttachmentKind = 'receipt' | 'booking' | 'accommodation' | 'other';

export interface AttachmentTarget {
  tripId?: string | null;
  tripDayId?: string | null;
}

export class InvalidAttachmentTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttachmentTargetError';
  }
}

/** Throws unless exactly one of `tripId`/`tripDayId` is a non-empty id — `''` counts as absent, the same way the upload route reads its form fields. */
export function validateAttachmentTarget(target: AttachmentTarget): void {
  const hasTripId = typeof target.tripId === 'string' && target.tripId.length > 0;
  const hasTripDayId = typeof target.tripDayId === 'string' && target.tripDayId.length > 0;

  if (hasTripId === hasTripDayId) {
    throw new InvalidAttachmentTargetError(
      hasTripId
        ? 'An attachment must be tied to a trip or a specific day, not both.'
        : 'An attachment must be tied to a trip or a specific day.',
    );
  }
}

export interface CreateAttachmentInput extends AttachmentTarget {
  kind: AttachmentKind;
  title: string;
  storageKey: string;
}

export async function createAttachment(
  db: TravellogDb,
  actor: { userId: string; tenantId: string },
  input: CreateAttachmentInput,
): Promise<AttachmentRow> {
  validateAttachmentTarget(input);

  const id = newId();
  const now = Date.now();
  await db.insert(schema.attachments).values({
    id,
    tenantId: actor.tenantId,
    tripId: input.tripId || null,
    tripDayId: input.tripDayId || null,
    kind: input.kind,
    title: input.title,
    storageKey: input.storageKey,
    createdBy: actor.userId,
    createdAt: now,
  });

  const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id));
  if (!row) throw new Error('createAttachment: insert did not return a row');
  return row;
}

/**
 * Only removes the DB row — the caller (`../actions.ts`) is responsible
 * for also calling `sdk.storage.delete()` with the row's `storageKey`
 * (returned here so the caller doesn't need a second read). Kept as two
 * separate steps, same reasoning as `T.8`'s upload route never calling
 * `sdk.storage` from inside a plain data-layer function: this file stays
 * testable against a bare DB, no SDK mock required.
 */
export async function deleteAttachment(
  db: TravellogDb,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const [row] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId));
  if (!row) return null;
  await db.delete(schema.attachments).where(eq(schema.attachments.id, attachmentId));
  return row;
}

/**
 * `T.17` — every attachment under a trip, oldest first: the trip-level ones
 * *and* the day-level ones (a day attachment has `tripId: null` by the XOR
 * rule above, so a plain `WHERE trip_id = ?` silently dropped them — the
 * export and the detail panel both used to). The caller resolves ownership
 * before calling this (`../actions.ts`'s own convention).
 */
export async function listAttachments(db: TravellogDb, tripId: string): Promise<AttachmentRow[]> {
  const dayRows = await db
    .select({ id: schema.tripDays.id })
    .from(schema.tripDays)
    .where(eq(schema.tripDays.tripId, tripId));
  const dayIds = dayRows.map((d) => d.id);
  return db
    .select()
    .from(schema.attachments)
    .where(
      dayIds.length > 0
        ? or(eq(schema.attachments.tripId, tripId), inArray(schema.attachments.tripDayId, dayIds))
        : eq(schema.attachments.tripId, tripId),
    )
    .orderBy(asc(schema.attachments.createdAt));
}

export type AttachmentWithDate = AttachmentRow & { date: string | null };

/** `listAttachments` plus each day-level attachment's calendar date (`null` for trip-level) — what the detail panel renders. */
export async function listAttachmentsWithDates(
  db: TravellogDb,
  tripId: string,
): Promise<AttachmentWithDate[]> {
  const rows = await listAttachments(db, tripId);
  const dayIds = rows.map((r) => r.tripDayId).filter((id): id is string => id !== null);
  const dates = new Map<string, string>();
  if (dayIds.length > 0) {
    const days = await db
      .select({ id: schema.tripDays.id, date: schema.tripDays.date })
      .from(schema.tripDays)
      .where(inArray(schema.tripDays.id, dayIds));
    for (const day of days) dates.set(day.id, day.date);
  }
  return rows.map((row) => ({
    ...row,
    date: row.tripDayId ? (dates.get(row.tripDayId) ?? null) : null,
  }));
}
