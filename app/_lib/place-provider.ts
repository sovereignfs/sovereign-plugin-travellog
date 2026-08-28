/**
 * The place-search abstraction every screen that needs a place goes
 * through — check-in, Planner's stop/itinerary-item pickers. Swappable
 * behind `getPlaceProvider()`; no call site imports a concrete provider
 * (e.g. `./providers/manual-place-provider`, `./providers/osm-place-provider`)
 * directly. See SPEC.md's Data model section.
 *
 * `getPlaceProvider()` is async (a change from `T.3`'s first draft, which
 * had it synchronous) — resolving the operator's configured Nominatim base
 * URL via `sdk.env.get()` is itself async, and the factory is the one place
 * that resolution should happen so every future call site gets it for
 * free rather than having to plumb config through itself.
 */
import { sdk } from '@sovereignfs/sdk';
import type { TravellogDb } from '../_db/client';
import { createMergedPlaceProvider } from './providers/merged-place-provider';
import { createManualPlaceProvider } from './providers/manual-place-provider';
import { createOsmPlaceProvider } from './providers/osm-place-provider';

export interface PlaceCandidate {
  name: string;
  lat: number | null;
  lng: number | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
  category?: string | null;
  sourceRef?: string | null;
  /**
   * Set only when this candidate IS an existing `travellog_places` row —
   * the caller reuses this place directly instead of calling
   * `createPlace()` (../places.ts), which would otherwise mint a duplicate
   * row for a place that already exists. Undefined for a candidate from an
   * external provider (T.3a's OSM adapter) that has never been created
   * locally.
   */
  existingPlaceId?: string;
}

export interface PlaceProvider {
  search(query: string, near?: { lat: number; lng: number }): Promise<PlaceCandidate[]>;
  reverseGeocode(lat: number, lng: number): Promise<PlaceCandidate | null>;
}

export interface PlaceProviderContext {
  tenantId: string;
}

/**
 * Matches the manifest's own declared `env.NOMINATIM_BASE_URL.default` —
 * kept here too as defense in depth, since `sdk.env.get()` only reads
 * `process.env` (the platform applies the manifest default to it at
 * startup; this constant covers any environment where that startup step
 * hasn't run, e.g. a script invoked outside the runtime).
 */
export const DEFAULT_NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';

/** The one place a call site asks for a provider — never import a concrete one directly. */
export async function getPlaceProvider(
  db: TravellogDb,
  ctx: PlaceProviderContext,
): Promise<PlaceProvider> {
  const manual = createManualPlaceProvider(db, ctx);
  const baseUrl = (await sdk.env.get('NOMINATIM_BASE_URL')) ?? DEFAULT_NOMINATIM_BASE_URL;
  const osm = createOsmPlaceProvider({ baseUrl });
  return createMergedPlaceProvider(manual, osm);
}
