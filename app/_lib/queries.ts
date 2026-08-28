/**
 * Read-side query layer for the Check-ins screen (SPEC.md's Data fetching
 * contract, payloads 4–5). Every query is ownership-scoped in its own
 * WHERE clause — a page-rendering caller never has to remember a separate
 * authz call to keep "reading someone else's visit is impossible" true
 * (`T.4`'s review checklist).
 */
import { and, asc, count, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import type { Actor } from './authz';

const NOTE_EXCERPT_LENGTH = 140;

function excerpt(note: string | null): string | null {
  if (!note) return null;
  return note.length > NOTE_EXCERPT_LENGTH ? `${note.slice(0, NOTE_EXCERPT_LENGTH)}…` : note;
}

// ---------------------------------------------------------------------------
// Timeline (payload 4)

export interface TimelineVisit {
  id: string;
  happenedAt: number;
  tzIana: string;
  placeName: string;
  placeCategory: string | null;
  noteExcerpt: string | null;
  firstPhotoStorageKey: string | null;
  /** Always null until T.10 — kept in the payload shape so T.6 doesn't need a later reshape. */
  tripId: string | null;
}

export interface VisitTimelineCursor {
  happenedAt: number;
  id: string;
}

export interface VisitTimelinePage {
  items: TimelineVisit[];
  nextCursor: VisitTimelineCursor | null;
}

export const VISIT_TIMELINE_PAGE_SIZE = 30;

/** A cursor only when the page was actually full — a partial page is always the last one. */
function timelineCursorFor(
  items: Array<{ id: string; happenedAt: number }>,
): VisitTimelineCursor | null {
  if (items.length < VISIT_TIMELINE_PAGE_SIZE) return null;
  const last = items[items.length - 1];
  return last ? { happenedAt: last.happenedAt, id: last.id } : null;
}

async function getFirstPhotoByVisitId(
  db: TravellogDb,
  visitIds: string[],
): Promise<Map<string, string>> {
  if (visitIds.length === 0) return new Map();

  const rows = await db
    .select({
      visitId: schema.visitPhotos.visitId,
      storageKey: schema.visitPhotos.storageKey,
      position: schema.visitPhotos.position,
    })
    .from(schema.visitPhotos)
    .where(inArray(schema.visitPhotos.visitId, visitIds));

  const first = new Map<string, { storageKey: string; position: number }>();
  for (const row of rows) {
    const existing = first.get(row.visitId);
    if (!existing || row.position < existing.position) {
      first.set(row.visitId, { storageKey: row.storageKey, position: row.position });
    }
  }
  return new Map([...first].map(([visitId, photo]) => [visitId, photo.storageKey]));
}

/**
 * Reverse-chronological, `(happenedAt, id)`-cursored so a page boundary
 * can never duplicate or skip a row that shares a millisecond timestamp
 * with its neighbour — same pattern as `sovereign-plugin-kanban`'s
 * `getActivityPage`. Day-grouping for display is `T.6`'s presentation
 * concern, not baked in here.
 */
export async function getVisitTimelinePage(
  db: TravellogDb,
  actor: Actor,
  cursor?: VisitTimelineCursor,
): Promise<VisitTimelinePage> {
  const conditions = [eq(schema.visits.userId, actor.userId), eq(schema.visits.tenantId, actor.tenantId)];
  const cursorCondition = cursor
    ? or(
        lt(schema.visits.happenedAt, cursor.happenedAt),
        and(eq(schema.visits.happenedAt, cursor.happenedAt), lt(schema.visits.id, cursor.id)),
      )
    : undefined;
  if (cursorCondition) conditions.push(cursorCondition);

  const rows = await db
    .select({
      id: schema.visits.id,
      happenedAt: schema.visits.happenedAt,
      tzIana: schema.visits.tzIana,
      note: schema.visits.note,
      tripId: schema.visits.tripId,
      placeName: schema.places.name,
      placeCategory: schema.places.category,
    })
    .from(schema.visits)
    .innerJoin(schema.places, eq(schema.places.id, schema.visits.placeId))
    .where(and(...conditions))
    .orderBy(desc(schema.visits.happenedAt), desc(schema.visits.id))
    .limit(VISIT_TIMELINE_PAGE_SIZE);

  const firstPhotoByVisitId = await getFirstPhotoByVisitId(
    db,
    rows.map((r) => r.id),
  );

  const items: TimelineVisit[] = rows.map((row) => ({
    id: row.id,
    happenedAt: row.happenedAt,
    tzIana: row.tzIana,
    placeName: row.placeName,
    placeCategory: row.placeCategory,
    noteExcerpt: excerpt(row.note),
    firstPhotoStorageKey: firstPhotoByVisitId.get(row.id) ?? null,
    tripId: row.tripId,
  }));

  return { items, nextCursor: timelineCursorFor(items) };
}

// ---------------------------------------------------------------------------
// Detail (payload 5)

export interface VisitDetail {
  id: string;
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note: string | null;
  companions: string[];
  tripId: string | null;
  place: {
    id: string;
    name: string;
    category: string | null;
    lat: number | null;
    lng: number | null;
  };
  /** Total visits the caller has logged at this place, including this one — CONCEPT.md's Slice 1 "per-place visit counts." */
  placeVisitCount: number;
  photos: Array<{ id: string; storageKey: string; position: number }>;
}

export async function getVisitDetail(
  db: TravellogDb,
  actor: Actor,
  visitId: string,
): Promise<VisitDetail | null> {
  const rows = await db
    .select({
      id: schema.visits.id,
      happenedAt: schema.visits.happenedAt,
      tzIana: schema.visits.tzIana,
      tzOffsetMinutes: schema.visits.tzOffsetMinutes,
      note: schema.visits.note,
      companions: schema.visits.companions,
      tripId: schema.visits.tripId,
      placeId: schema.places.id,
      placeName: schema.places.name,
      placeCategory: schema.places.category,
      placeLat: schema.places.lat,
      placeLng: schema.places.lng,
    })
    .from(schema.visits)
    .innerJoin(schema.places, eq(schema.places.id, schema.visits.placeId))
    .where(
      and(
        eq(schema.visits.id, visitId),
        eq(schema.visits.userId, actor.userId),
        eq(schema.visits.tenantId, actor.tenantId),
      ),
    );

  const row = rows[0];
  if (!row) return null;

  const [photos, placeVisitCountRow] = await Promise.all([
    db
      .select()
      .from(schema.visitPhotos)
      .where(eq(schema.visitPhotos.visitId, visitId))
      .orderBy(asc(schema.visitPhotos.position)),
    db
      .select({ value: count() })
      .from(schema.visits)
      .where(
        and(
          eq(schema.visits.placeId, row.placeId),
          eq(schema.visits.userId, actor.userId),
          eq(schema.visits.tenantId, actor.tenantId),
        ),
      ),
  ]);

  return {
    id: row.id,
    happenedAt: row.happenedAt,
    tzIana: row.tzIana,
    tzOffsetMinutes: row.tzOffsetMinutes,
    note: row.note,
    companions: row.companions ? (JSON.parse(row.companions) as string[]) : [],
    tripId: row.tripId,
    place: {
      id: row.placeId,
      name: row.placeName,
      category: row.placeCategory,
      lat: row.placeLat,
      lng: row.placeLng,
    },
    placeVisitCount: placeVisitCountRow[0]?.value ?? 1,
    photos: photos.map((p) => ({ id: p.id, storageKey: p.storageKey, position: p.position })),
  };
}
