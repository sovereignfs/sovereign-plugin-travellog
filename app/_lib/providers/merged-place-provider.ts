/**
 * Combines the manual provider (the tenant's own existing places — cheap,
 * always available, always tried) with an external provider (OSM today,
 * `T.3a`) into the one `PlaceProvider` `getPlaceProvider()` hands out.
 *
 * Local matches are returned first: "you've been here before" is a
 * stronger, more useful signal than a generic new suggestion, and it's
 * exactly what `T.3`'s own search existed to surface (re-visiting "my
 * local café" shouldn't mean re-typing it). The external provider's
 * results are appended, never used to replace local ones — if it's
 * rate-limited, unreachable, or misconfigured, local search still works
 * and the whole search never errors (SPEC.md's `T.3a` review checklist).
 *
 * Known, accepted limitation: no de-duplication between a local match and
 * an external candidate that happen to be the same real-world place. Not
 * attempted in phase 1 — fuzzy place matching is its own problem, and a
 * duplicate-looking pair is a minor UX rough edge, not a correctness bug.
 */
import type { PlaceCandidate, PlaceProvider } from '../place-provider';

export function createMergedPlaceProvider(
  primary: PlaceProvider,
  secondary: PlaceProvider,
): PlaceProvider {
  return {
    async search(query, near) {
      const [primaryResults, secondaryResults] = await Promise.all([
        primary.search(query, near),
        secondary.search(query, near),
      ]);
      return [...primaryResults, ...secondaryResults];
    },

    async reverseGeocode(lat, lng): Promise<PlaceCandidate | null> {
      const primaryResult = await primary.reverseGeocode(lat, lng);
      if (primaryResult) return primaryResult;
      return secondary.reverseGeocode(lat, lng);
    },
  };
}
