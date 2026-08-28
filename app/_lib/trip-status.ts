/**
 * A trip's status is computed, never stored (SPEC.md's Data model notes) —
 * a pure function so every screen that needs it (`T.13`'s cards, `T.14`'s
 * detail column, `T.15`'s Planner picker) gets the identical answer instead
 * of re-deriving it ad hoc. See `CONCEPT.md`'s open question 3 for the
 * alternative (an explicit, user-set status) this deliberately doesn't
 * build yet.
 */
import { compareDateKeys } from './dates';

export type TripStatus = 'planning' | 'upcoming' | 'ongoing' | 'completed';

export interface TripStatusInput {
  /** Whether the trip has any stops at all — zero stops always means `planning`. */
  hasStops: boolean;
  /** The trip's denormalized, stop-derived start date — null iff hasStops is false. */
  startDate: string | null;
  /** The trip's denormalized, stop-derived end date — null iff hasStops is false. */
  endDate: string | null;
}

/**
 * `todayKey` is the caller's reference "today" (`./dates.ts`'s
 * `todayDateKey()` in production, an explicit value in tests) — never read
 * from `Date.now()` internally, so this stays a pure, trivially
 * boundary-testable function.
 */
export function resolveTripStatus(input: TripStatusInput, todayKey: string): TripStatus {
  if (!input.hasStops || input.startDate === null || input.endDate === null) {
    return 'planning';
  }
  if (compareDateKeys(todayKey, input.startDate) < 0) return 'upcoming';
  if (compareDateKeys(todayKey, input.endDate) > 0) return 'completed';
  return 'ongoing';
}
