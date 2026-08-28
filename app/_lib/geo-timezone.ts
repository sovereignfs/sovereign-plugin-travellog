/**
 * `T.20` — the one source of "the traveler's local zone" a background
 * reminder tick can use. A stop carries no timezone of its own
 * (`_lib/dates.ts`'s header) and there's no request/browser to ask, unlike
 * `T.19`'s `TripModeScreen`, which reads `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * client-side. `trips.timezone` (schema.ts) is a nullable "home zone for
 * display" nothing currently writes, so it can't be relied on either.
 * Deriving from the active stop's own place coordinates is also more
 * correct than a single trip-level zone would be: a trip's stops can span
 * real timezones, and this always answers for the stop actually in
 * question, not wherever the trip was planned from.
 *
 * Offline, no network call — `tz-lookup`'s bundled boundary data, not a
 * geocoding API, matching this plugin's self-hosted posture. Approximate
 * near timezone borders (the library's own documented tradeoff for a small
 * footprint); acceptable here since a reminder a few minutes off due to a
 * border-adjacent zone guess is a much smaller failure than no reminder at
 * all.
 */
import tzlookup from 'tz-lookup';

/** `null` for missing coordinates (a manual place entry, or a title-only item) or a lookup failure — never guessed. */
export function resolveTimezoneFromCoords(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null;
  try {
    return tzlookup(lat, lng);
  } catch {
    return null;
  }
}
