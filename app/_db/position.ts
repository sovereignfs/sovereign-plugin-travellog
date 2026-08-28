/**
 * Fractional ordering helpers for `position` columns (visit photos now;
 * stops and itinerary items from T.10 onward).
 *
 * Strategy: rows are ordered by a REAL `position`. Appends step by
 * `POSITION_STEP`; an insert/move between two rows takes the midpoint, so a
 * reorder writes exactly one row. Repeated midpoint insertion at the same
 * spot halves the gap each time; when a gap underflows `MIN_GAP` the caller
 * renormalizes the whole sequence (one multi-row write inside a
 * transaction — the data layer in `app/` owns that transaction; these
 * helpers are pure so they stay trivially unit-testable). Same pattern as
 * `sovereign-plugin-kanban`'s `_db/position.ts` — reused rather than
 * re-derived, per SPEC.md's Data model notes.
 */

export const POSITION_STEP = 1024;

/**
 * Smallest gap midpoint insertion may leave behind. Well above the ~1e-13
 * float64 precision limit at plausible magnitudes, so a computed midpoint is
 * always strictly between its neighbours until renormalization kicks in.
 */
export const MIN_GAP = 1e-6;

/** Position for the first row of an empty sequence. */
export function firstPosition(): number {
  return POSITION_STEP;
}

/** Position for appending after the current last row (or into an empty sequence). */
export function positionAfter(last: number | undefined): number {
  return last === undefined ? firstPosition() : last + POSITION_STEP;
}

/** Position for prepending before the current first row (or into an empty sequence). */
export function positionBefore(first: number | undefined): number {
  return first === undefined ? firstPosition() : first - POSITION_STEP;
}

/**
 * Position strictly between two neighbours. Either side may be undefined
 * (insert at the start/end). Both defined requires prev < next.
 */
export function positionBetween(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return firstPosition();
  if (prev === undefined) return positionBefore(next);
  if (next === undefined) return positionAfter(prev);
  if (prev >= next) {
    throw new Error(`positionBetween: prev (${prev}) must be < next (${next})`);
  }
  return prev + (next - prev) / 2;
}

/**
 * Whether the gap between two neighbours is too small for further midpoint
 * insertion — the caller should renormalize the sequence first.
 */
export function needsRenormalize(prev: number | undefined, next: number | undefined): boolean {
  if (prev === undefined || next === undefined) return false;
  return next - prev < MIN_GAP;
}

/**
 * Fresh, evenly-spaced positions for an already-ordered sequence. Returns
 * one position per input row, in order (POSITION_STEP, 2*POSITION_STEP, …).
 * The caller writes them back in a single transaction.
 */
export function renormalizedPositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_STEP);
}
