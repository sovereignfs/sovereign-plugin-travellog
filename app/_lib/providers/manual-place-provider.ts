/**
 * Phase 1's only PlaceProvider (T.3): searches the tenant's own
 * previously-created places — any `source`, not just prior manual entries,
 * so an imported Swarm place is just as findable as a hand-entered one. No
 * external dependency, no network call, ships with zero configuration.
 * `reverseGeocode` always returns `null` — the manual provider has no
 * coordinate-to-place lookup of its own; a caller falls through to
 * "create new place" (../places.ts's `createPlace`) when nothing matches.
 *
 * Never imported by anything except ../place-provider.ts's factory — call
 * sites ask `getPlaceProvider()` for a provider, never this module
 * directly (SPEC.md's T.3 deliverable).
 */
import { and, eq, like } from 'drizzle-orm';
import type { TravellogDb } from '../../_db/client';
import * as schema from '../../_db/schema';
import { distanceMeters } from '../geo';
import type { PlaceCandidate, PlaceProvider, PlaceProviderContext } from '../place-provider';

function toCandidate(row: typeof schema.places.$inferSelect): PlaceCandidate {
  return {
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    countryCode: row.countryCode,
    postalCode: row.postalCode,
    category: row.category,
    sourceRef: row.sourceRef,
    existingPlaceId: row.id,
  };
}

export function createManualPlaceProvider(
  db: TravellogDb,
  ctx: PlaceProviderContext,
): PlaceProvider {
  return {
    async search(query, near) {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];

      const rows = await db
        .select()
        .from(schema.places)
        .where(
          and(eq(schema.places.tenantId, ctx.tenantId), like(schema.places.name, `%${trimmed}%`)),
        );

      const candidates = rows.map(toCandidate);
      if (!near) return candidates;

      // Bias toward nearby matches when the caller has a current position.
      // A candidate with no coordinates sorts last, never excluded — a
      // place with no pin is still a valid, selectable result.
      return candidates
        .map((candidate) => ({
          candidate,
          distance:
            candidate.lat !== null && candidate.lng !== null
              ? distanceMeters(near, { lat: candidate.lat, lng: candidate.lng })
              : Number.POSITIVE_INFINITY,
        }))
        .sort((a, b) => a.distance - b.distance)
        .map((entry) => entry.candidate);
    },

    async reverseGeocode() {
      return null;
    },
  };
}
