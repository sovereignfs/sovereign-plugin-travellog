/**
 * `T.18` — Trip Mode's "what does today look like right now" query. Pure
 * data/logic, no route or UI: `T.19` (the mobile screen) and `T.20` (the
 * "your next stop is in 20 minutes" notification) both call straight
 * through this, including `T.20` from a `sdk.schedules` background
 * handler — which is exactly why this takes `nowUtcMs`/`tzIana` as plain
 * parameters rather than reading `Date.now()` or a request header itself:
 * a background tick has no request to read a header from, and "now" here
 * always means the *traveler's* local instant, never the server's.
 *
 * Deliberately scoped to a single stop's single day — no cross-day or
 * cross-stop lookahead once today's items run out, no proximity/routing
 * resequencing (`CONCEPT.md`'s "Future (deferred)"). This resolves the
 * plan exactly as manually ordered, nothing smarter.
 */
import { and, asc, eq, lte, gte } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import { localDateKey, localTimeOfDay } from './timezone';

export interface TripModeItem {
  id: string;
  placeId: string | null;
  placeName: string | null;
  /** Nullable — a title-only item (or one whose place has no geocoded coordinates) has nothing to hand off to a maps app. */
  placeLat: number | null;
  placeLng: number | null;
  title: string | null;
  plannedTime: string | null;
  isFixed: boolean;
  notes: string | null;
  position: number;
}

export interface TripModeToday {
  tripDayId: string;
  /** The resolved local calendar date (`YYYY-MM-DD`) — `localDateKey(nowUtcMs, tzIana)`, not a UTC-derived guess. */
  date: string;
  /** Position order — matches the exact order `T.16`'s Planner shows, timed and untimed items interleaved. */
  items: TripModeItem[];
  /** The first item (by position) with a `plannedTime` strictly after `nowUtcMs` — `null` if none (nothing left today, or nothing timed at all). */
  nextItem: TripModeItem | null;
  /** Whole minutes from `nowUtcMs` to `nextItem.plannedTime`, always >= 0. `null` iff `nextItem` is `null`. */
  countdownMinutes: number | null;
}

function minutesSinceMidnight(timeOfDay: string): number {
  const [hours, minutes] = timeOfDay.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Resolves "today" for `stopId` from `nowUtcMs`/`tzIana` — never guessed
 * server-side, same "the client supplies its own timezone" rule
 * `_lib/timezone.ts`'s own header comment establishes for visits — then
 * that day's itinerary items and which one is next.
 *
 * Returns `null` when no `trip_day` matches today's *local* date for this
 * stop (today isn't within the stop's date range) — not an error, just
 * nothing to show; distinct from a real day that exists but has zero
 * itinerary items, which returns a `TripModeToday` with an empty `items`
 * array and a `null` `nextItem` (`T.18`'s own review checklist: "a day
 * with zero planned items" is an empty state, not this early return).
 */
export async function resolveTripModeToday(
  db: TravellogDb,
  stopId: string,
  nowUtcMs: number,
  tzIana: string,
): Promise<TripModeToday | null> {
  const date = localDateKey(nowUtcMs, tzIana);

  const [day] = await db
    .select({ id: schema.tripDays.id })
    .from(schema.tripDays)
    .where(and(eq(schema.tripDays.stopId, stopId), eq(schema.tripDays.date, date)));
  if (!day) return null;

  const rows = await db
    .select({
      id: schema.itineraryItems.id,
      placeId: schema.itineraryItems.placeId,
      placeName: schema.places.name,
      placeLat: schema.places.lat,
      placeLng: schema.places.lng,
      title: schema.itineraryItems.title,
      plannedTime: schema.itineraryItems.plannedTime,
      isFixed: schema.itineraryItems.isFixed,
      notes: schema.itineraryItems.notes,
      position: schema.itineraryItems.position,
    })
    .from(schema.itineraryItems)
    .leftJoin(schema.places, eq(schema.places.id, schema.itineraryItems.placeId))
    .where(eq(schema.itineraryItems.tripDayId, day.id))
    .orderBy(asc(schema.itineraryItems.position));

  const items: TripModeItem[] = rows.map((row) => ({
    id: row.id,
    placeId: row.placeId,
    placeName: row.placeName,
    placeLat: row.placeLat,
    placeLng: row.placeLng,
    title: row.title,
    plannedTime: row.plannedTime,
    isFixed: row.isFixed === 1,
    notes: row.notes,
    position: row.position,
  }));

  const nowTimeOfDay = localTimeOfDay(nowUtcMs, tzIana);
  // Strictly after "now" — an item planned for exactly this minute has
  // arrived, not "next"; scans in position order (not by nearest time),
  // matching this file's own header: exactly as manually ordered.
  const nextItem = items.find((item) => item.plannedTime !== null && item.plannedTime > nowTimeOfDay) ?? null;
  const countdownMinutes = nextItem?.plannedTime
    ? minutesSinceMidnight(nextItem.plannedTime) - minutesSinceMidnight(nowTimeOfDay)
    : null;

  return { tripDayId: day.id, date, items, nextItem, countdownMinutes };
}

export interface ActiveStopInfo {
  stopId: string;
  placeName: string;
  arriveDate: string;
  departDate: string;
}

/**
 * `T.19` — which of a trip's stops (if any) covers `dateKey`. A trip's
 * stops never overlap by construction (each is added/edited through
 * `_lib/stops.ts`'s own date validation against the others in sequence),
 * so at most one row can match — `null` when today falls before the first
 * stop, after the last, or in a gap between two stops with no days of
 * their own. This is the trip-wide half of Trip Mode's "active only within
 * the trip's real date range" gate; `resolveTripModeToday`, above, only
 * ever answers for a stop it's already been told about.
 */
export async function resolveActiveStop(
  db: TravellogDb,
  tripId: string,
  dateKey: string,
): Promise<ActiveStopInfo | null> {
  const [row] = await db
    .select({
      stopId: schema.stops.id,
      placeName: schema.places.name,
      arriveDate: schema.stops.arriveDate,
      departDate: schema.stops.departDate,
    })
    .from(schema.stops)
    .innerJoin(schema.places, eq(schema.places.id, schema.stops.placeId))
    .where(
      and(
        eq(schema.stops.tripId, tripId),
        lte(schema.stops.arriveDate, dateKey),
        gte(schema.stops.departDate, dateKey),
      ),
    );
  return row ?? null;
}
