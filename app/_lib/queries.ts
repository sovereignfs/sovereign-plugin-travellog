/**
 * Read-side query layer for the Check-ins screen (SPEC.md's Data fetching
 * contract, payloads 4–5). Every query is ownership-scoped in its own
 * WHERE clause — a page-rendering caller never has to remember a separate
 * authz call to keep "reading someone else's visit is impossible" true
 * (`T.4`'s review checklist).
 */
import { and, asc, count, countDistinct, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import type { Actor } from './authz';
import { compareDateKeys, daysBetweenDateKeys, todayDateKey } from './dates';
import { resolveTripStatus, type TripStatus } from './trip-status';

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

// ---------------------------------------------------------------------------
// Trips overview (T.13, payload 1)

export interface TripsOverview {
  tripCounts: Record<TripStatus, number>;
  /** Distinct places across every visit the caller has ever logged — the whole check-in history, not trip stops. */
  uniquePlaceCount: number;
  /** Distinct `places.country` across the same visits — nulls (no country on the place) never count. */
  uniqueCountryCount: number;
  totalCheckins: number;
  /** The soonest `upcoming` trip, or null when none is — CONCEPT.md's "next trip in N days" highlight. */
  nextTrip: { id: string; name: string; daysUntil: number } | null;
}

/**
 * Status is computed here (`resolveTripStatus`, `T.11`), not in SQL — every
 * trip a caller owns is a small, bounded list (unlike check-in history,
 * which can span a decade of imports), so fetching every trip row and
 * tallying statuses in application code is simpler than a per-row SQL CASE
 * expression, while the genuinely large-cardinality aggregates (unique
 * places/countries/check-ins, all scale with check-in history) stay real
 * SQL `COUNT`/`COUNT DISTINCT` — never fetched row-by-row to compute
 * client-side (SPEC.md's Data fetching contract).
 */
export async function getTripsOverview(
  db: TravellogDb,
  actor: Actor,
  todayKey: string = todayDateKey(),
): Promise<TripsOverview> {
  const [trips, [visitAgg]] = await Promise.all([
    db
      .select({ id: schema.trips.id, name: schema.trips.name, startDate: schema.trips.startDate, endDate: schema.trips.endDate })
      .from(schema.trips)
      .where(and(eq(schema.trips.ownerId, actor.userId), eq(schema.trips.tenantId, actor.tenantId))),
    db
      .select({
        totalCheckins: count(),
        uniquePlaceCount: countDistinct(schema.visits.placeId),
        uniqueCountryCount: countDistinct(schema.places.country),
      })
      .from(schema.visits)
      .innerJoin(schema.places, eq(schema.places.id, schema.visits.placeId))
      .where(and(eq(schema.visits.userId, actor.userId), eq(schema.visits.tenantId, actor.tenantId))),
  ]);

  const tripCounts: Record<TripStatus, number> = { planning: 0, upcoming: 0, ongoing: 0, completed: 0 };
  let nextTrip: TripsOverview['nextTrip'] = null;
  let nextTripStartDate: string | null = null;

  for (const trip of trips) {
    const hasStops = trip.startDate !== null && trip.endDate !== null;
    const status = resolveTripStatus({ hasStops, startDate: trip.startDate, endDate: trip.endDate }, todayKey);
    tripCounts[status]++;

    if (status === 'upcoming' && trip.startDate) {
      if (!nextTripStartDate || compareDateKeys(trip.startDate, nextTripStartDate) < 0) {
        nextTripStartDate = trip.startDate;
        nextTrip = { id: trip.id, name: trip.name, daysUntil: daysBetweenDateKeys(todayKey, trip.startDate) };
      }
    }
  }

  return {
    tripCounts,
    uniquePlaceCount: visitAgg?.uniquePlaceCount ?? 0,
    uniqueCountryCount: visitAgg?.uniqueCountryCount ?? 0,
    totalCheckins: visitAgg?.totalCheckins ?? 0,
    nextTrip,
  };
}

// ---------------------------------------------------------------------------
// Trip cards (T.13, payload 2)

export interface TripCard {
  id: string;
  name: string;
  status: TripStatus;
  startDate: string | null;
  endDate: string | null;
  stopCount: number;
  /** Total `trip_days` rows across all of the trip's stops. */
  dayCount: number;
  /** First stop's place name, plus a count of any additional stops (e.g. "Lisbon +2") — null for a trip with no stops yet. */
  destinationSummary: string | null;
  /**
   * Lightweight, informational tags (`schema.ts`'s header comment — no real
   * `travellog_trip_members` table). Carried on the card payload, not just
   * fetched separately for the detail column, so `T.14`'s `TripDetailPanel`
   * needs no second round trip for data this same query already touches.
   */
  companions: string[];
}

/**
 * Not paginated, deliberately — a personal trip list is small and bounded
 * (unlike check-in history), and the wireframe (`docs/adhoc/web-trips.md`)
 * filters client-side over one already-fetched page. Three queries total
 * regardless of trip count (trips, their stops+place-names, their day
 * counts) — never N+1 per trip.
 */
export async function listTripCards(db: TravellogDb, actor: Actor): Promise<TripCard[]> {
  const trips = await db
    .select({
      id: schema.trips.id,
      name: schema.trips.name,
      startDate: schema.trips.startDate,
      endDate: schema.trips.endDate,
      companions: schema.trips.companions,
    })
    .from(schema.trips)
    .where(and(eq(schema.trips.ownerId, actor.userId), eq(schema.trips.tenantId, actor.tenantId)));

  if (trips.length === 0) return [];
  const tripIds = trips.map((t) => t.id);

  const [stopRows, dayCountRows] = await Promise.all([
    db
      .select({
        tripId: schema.stops.tripId,
        position: schema.stops.position,
        placeName: schema.places.name,
      })
      .from(schema.stops)
      .innerJoin(schema.places, eq(schema.places.id, schema.stops.placeId))
      .where(inArray(schema.stops.tripId, tripIds))
      .orderBy(asc(schema.stops.position)),
    db
      .select({ tripId: schema.tripDays.tripId, dayCount: count() })
      .from(schema.tripDays)
      .where(inArray(schema.tripDays.tripId, tripIds))
      .groupBy(schema.tripDays.tripId),
  ]);

  const stopsByTrip = new Map<string, { placeName: string }[]>();
  for (const row of stopRows) {
    const list = stopsByTrip.get(row.tripId) ?? [];
    list.push({ placeName: row.placeName });
    stopsByTrip.set(row.tripId, list);
  }
  const dayCountByTrip = new Map(dayCountRows.map((r) => [r.tripId, r.dayCount]));

  const todayKey = todayDateKey();
  return trips.map((trip) => {
    const stops = stopsByTrip.get(trip.id) ?? [];
    const first = stops[0];
    const hasStops = trip.startDate !== null && trip.endDate !== null;
    return {
      id: trip.id,
      name: trip.name,
      status: resolveTripStatus({ hasStops, startDate: trip.startDate, endDate: trip.endDate }, todayKey),
      startDate: trip.startDate,
      endDate: trip.endDate,
      stopCount: stops.length,
      dayCount: dayCountByTrip.get(trip.id) ?? 0,
      destinationSummary: first
        ? stops.length > 1
          ? `${first.placeName} +${String(stops.length - 1)}`
          : first.placeName
        : null,
      companions: trip.companions ? (JSON.parse(trip.companions) as string[]) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Trip picker (T.15, payload 6)

export interface TripPickerEntry {
  id: string;
  name: string;
  status: TripStatus;
  startDate: string | null;
  endDate: string | null;
  stopCount: number;
}

/**
 * `planning`/`upcoming` trips only — an already-completed (or ongoing)
 * trip's itinerary is edited from Trips instead (`docs/adhoc/web-planner.md`
 * screen 1). A lighter fetch than `listTripCards`: no stop/place join for a
 * destination summary and no day count, since the picker only ever shows a
 * stop count — those extra joins would be pure waste here.
 */
export async function listTripsForPicker(db: TravellogDb, actor: Actor): Promise<TripPickerEntry[]> {
  const trips = await db
    .select({ id: schema.trips.id, name: schema.trips.name, startDate: schema.trips.startDate, endDate: schema.trips.endDate })
    .from(schema.trips)
    .where(and(eq(schema.trips.ownerId, actor.userId), eq(schema.trips.tenantId, actor.tenantId)));

  if (trips.length === 0) return [];
  const tripIds = trips.map((t) => t.id);

  const stopCountRows = await db
    .select({ tripId: schema.stops.tripId, stopCount: count() })
    .from(schema.stops)
    .where(inArray(schema.stops.tripId, tripIds))
    .groupBy(schema.stops.tripId);
  const stopCountByTrip = new Map(stopCountRows.map((r) => [r.tripId, r.stopCount]));

  const todayKey = todayDateKey();
  const entries: TripPickerEntry[] = [];
  for (const trip of trips) {
    const hasStops = trip.startDate !== null && trip.endDate !== null;
    const status = resolveTripStatus({ hasStops, startDate: trip.startDate, endDate: trip.endDate }, todayKey);
    if (status !== 'planning' && status !== 'upcoming') continue;
    entries.push({
      id: trip.id,
      name: trip.name,
      status,
      startDate: trip.startDate,
      endDate: trip.endDate,
      stopCount: stopCountByTrip.get(trip.id) ?? 0,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Planner workspace (T.15, payload 7's stop list)

export interface WorkspaceStop {
  id: string;
  placeName: string;
  arriveDate: string;
  departDate: string;
}

/**
 * The place-enriched sibling of `_lib/stops.ts`'s `listStops` — that one
 * returns raw `StopRow`s (no place name) for mutation call sites that don't
 * need one; `PlannerStopStrip` renders a place name per chip, so this joins
 * `places` too. Actor-scoped via a join to `trips`, matching this file's own
 * "every query is ownership-scoped in its own WHERE clause" invariant, even
 * though the caller (`planner/[tripId]/page.tsx`) already resolves the trip
 * through `requireTripOwner` first — cheap defense in depth, not load-bearing.
 */
export async function listWorkspaceStops(
  db: TravellogDb,
  actor: Actor,
  tripId: string,
): Promise<WorkspaceStop[]> {
  const rows = await db
    .select({
      id: schema.stops.id,
      placeName: schema.places.name,
      arriveDate: schema.stops.arriveDate,
      departDate: schema.stops.departDate,
    })
    .from(schema.stops)
    .innerJoin(schema.places, eq(schema.places.id, schema.stops.placeId))
    .innerJoin(schema.trips, eq(schema.trips.id, schema.stops.tripId))
    .where(
      and(
        eq(schema.stops.tripId, tripId),
        eq(schema.trips.ownerId, actor.userId),
        eq(schema.trips.tenantId, actor.tenantId),
      ),
    )
    .orderBy(asc(schema.stops.position));
  return rows;
}
