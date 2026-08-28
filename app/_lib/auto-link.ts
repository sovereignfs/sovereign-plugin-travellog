/**
 * `T.12`'s auto-link engine (SPEC.md's Data model "Auto-link algorithm"
 * note): a visit's *local calendar date* (its `happenedAt` + `tzIana`, via
 * `./timezone.ts`'s `localDateKey`, never the raw UTC instant) is compared
 * against every one of the actor's trips' derived `[startDate, endDate]`
 * range (`./dates.ts` calendar-date arithmetic — a trip with no stops has
 * null dates and never matches, which is exactly right: a `planning` trip
 * can't auto-link anything). Zero matches → `tripId: null` (not an error —
 * most check-ins aren't on a trip). One match → link it. Multiple matches
 * (e.g. a work trip and a personal weekend sharing dates) → the
 * **narrower** date range wins, never left ambiguous.
 *
 * Every function here takes `TravellogDb | TravellogTx` so `./visits.ts`'s
 * `createVisit` can call `computeAutoLinkForVisit` from inside its own
 * transaction (the same DB connection sees its own not-yet-committed
 * insert), while `recomputeAutoLinksForActor` also runs standalone from a
 * plain action.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import type { TravellogDb, TravellogTx } from '../_db/client';
import * as schema from '../_db/schema';
import { compareDateKeys, daysBetweenDateKeys } from './dates';
import { localDateKey } from './timezone';

type Db = TravellogDb | TravellogTx;

export interface AutoLinkActor {
  userId: string;
  tenantId: string;
}

interface TripDateRange {
  tripId: string;
  startDate: string;
  endDate: string;
}

/**
 * Pure — no DB access. Exported mainly so its tie-break rule is directly
 * unit-testable without seeding a database. Ties on range width (equal
 * widths, both matching) break on the earlier `startDate`, then the lower
 * `tripId` — arbitrary but deterministic, so "never left ambiguous when at
 * least one candidate exists" (SPEC.md) holds even in a tie.
 */
export function pickBestTrip(visitDateKey: string, trips: TripDateRange[]): string | null {
  const matches = trips.filter(
    (trip) =>
      compareDateKeys(trip.startDate, visitDateKey) <= 0 &&
      compareDateKeys(visitDateKey, trip.endDate) <= 0,
  );
  if (matches.length === 0) return null;

  let best = matches[0];
  if (!best) return null;
  let bestWidth = daysBetweenDateKeys(best.startDate, best.endDate);

  for (const candidate of matches.slice(1)) {
    const width = daysBetweenDateKeys(candidate.startDate, candidate.endDate);
    const narrower = width < bestWidth;
    const tiedButEarlier =
      width === bestWidth &&
      (compareDateKeys(candidate.startDate, best.startDate) < 0 ||
        (candidate.startDate === best.startDate && candidate.tripId < best.tripId));
    if (narrower || tiedButEarlier) {
      best = candidate;
      bestWidth = width;
    }
  }
  return best.tripId;
}

async function tripDateRangesForActor(db: Db, actor: AutoLinkActor): Promise<TripDateRange[]> {
  const rows = await db
    .select({ tripId: schema.trips.id, startDate: schema.trips.startDate, endDate: schema.trips.endDate })
    .from(schema.trips)
    .where(and(eq(schema.trips.ownerId, actor.userId), eq(schema.trips.tenantId, actor.tenantId)));

  const ranges: TripDateRange[] = [];
  for (const row of rows) {
    if (row.startDate !== null && row.endDate !== null) {
      ranges.push({ tripId: row.tripId, startDate: row.startDate, endDate: row.endDate });
    }
  }
  return ranges;
}

export interface AutoLinkResult {
  tripId: string | null;
  linkSource: 'auto' | null;
}

/** For a brand-new visit (`./visits.ts`'s `createVisit` calls this inside its own transaction). */
export async function computeAutoLinkForVisit(
  db: Db,
  actor: AutoLinkActor,
  visit: { happenedAt: number; tzIana: string },
): Promise<AutoLinkResult> {
  const dateKey = localDateKey(visit.happenedAt, visit.tzIana);
  const trips = await tripDateRangesForActor(db, actor);
  const tripId = pickBestTrip(dateKey, trips);
  return tripId ? { tripId, linkSource: 'auto' } : { tripId: null, linkSource: null };
}

/**
 * Re-derives every eligible visit's best-matching trip — called whenever a
 * trip's stops change (`./stops.ts`'s create/update/delete/reorder) and
 * exposed as its own action for a manual re-run. "Eligible" is `linkSource
 * IS NULL OR linkSource = 'auto'` — a `'manual'` row is **never** touched,
 * regardless of whether its `tripId` is set or null (a visit the user
 * explicitly unlinked, `{tripId: null, linkSource: 'manual'}`, must stay
 * unlinked through a recompute exactly as much as a visit explicitly
 * pinned to a specific trip must stay pinned — see `./visits.ts`'s
 * `setVisitTripLink` for where that state is written).
 *
 * Scoped to the whole actor, not just the one trip that changed — a single
 * trip's date-range edit can change which trip is "narrower" for a visit
 * currently linked to a *different* trip, so a narrower scope would miss
 * real reshuffles. Returns how many visits actually changed, so a caller
 * can report "updated N check-ins" rather than a generic "done."
 */
export async function recomputeAutoLinksForActor(db: Db, actor: AutoLinkActor): Promise<number> {
  const trips = await tripDateRangesForActor(db, actor);
  const visits = await db
    .select({
      id: schema.visits.id,
      happenedAt: schema.visits.happenedAt,
      tzIana: schema.visits.tzIana,
      tripId: schema.visits.tripId,
    })
    .from(schema.visits)
    .where(
      and(
        eq(schema.visits.userId, actor.userId),
        eq(schema.visits.tenantId, actor.tenantId),
        or(isNull(schema.visits.linkSource), eq(schema.visits.linkSource, 'auto')),
      ),
    );

  let changed = 0;
  for (const visit of visits) {
    const dateKey = localDateKey(visit.happenedAt, visit.tzIana);
    const bestTripId = pickBestTrip(dateKey, trips);
    if (bestTripId !== visit.tripId) {
      await db
        .update(schema.visits)
        .set({ tripId: bestTripId, linkSource: bestTripId ? 'auto' : null, updatedAt: Date.now() })
        .where(eq(schema.visits.id, visit.id));
      changed++;
    }
  }
  return changed;
}
