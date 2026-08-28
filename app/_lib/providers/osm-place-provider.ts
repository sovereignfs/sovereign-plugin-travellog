/**
 * OSM-backed PlaceProvider (T.3a) — Nominatim `/search` and `/reverse`,
 * against an operator-configurable base URL (defaults to the public
 * instance). Never imported except by ../place-provider.ts's factory.
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * requires: max 1 request/second, a valid identifying User-Agent, and
 * caching results rather than re-requesting. This provider enforces the
 * rate limit itself (skips the network call and returns an empty/null
 * result rather than queuing or blocking — SPEC.md's T.3a review checklist:
 * "hitting the provider's rate limit degrades... without erroring the
 * whole check-in flow") and caches responses in-process. An operator
 * running their own Nominatim/Photon-compatible instance can raise these
 * limits by pointing `NOMINATIM_BASE_URL` at it — the policy constants
 * below are polite defaults for the shared public instance, not hardcoded
 * assumptions about every deployment.
 *
 * Never throws: a network error, a non-2xx response, or a rate-limit skip
 * all degrade to `[]`/`null` so a caller composing this with the manual
 * provider (../providers/merged-place-provider.ts) never has to catch
 * anything from this provider specifically.
 */
import type { PlaceCandidate, PlaceProvider } from '../place-provider';

/** Nominatim's own policy: max 1 req/s. A small margin avoids edge-of-window rejection. */
const MIN_REQUEST_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Identifies this software to the Nominatim server, per its usage policy —
 * an unidentified or generic User-Agent is explicitly disallowed and may be
 * blocked.
 */
const USER_AGENT =
  'SovereignTravellog/1 (self-hosted Sovereign plugin; https://github.com/sovereignfs/sovereign-plugin-travellog)';

export interface OsmPlaceProviderOptions {
  /** No trailing slash required — normalized internally. */
  baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface NominatimAddress {
  road?: string;
  house_number?: string;
  city?: string;
  town?: string;
  village?: string;
  state?: string;
  country?: string;
  country_code?: string;
  postcode?: string;
}

interface NominatimResult {
  place_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  type?: string;
  category?: string;
  address?: NominatimAddress;
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapResult(result: NominatimResult): PlaceCandidate | null {
  const name = result.name?.trim() || result.display_name?.split(',')[0]?.trim();
  if (!name) return null;

  const address = result.address;
  return {
    name,
    lat: toNumberOrNull(result.lat),
    lng: toNumberOrNull(result.lon),
    address: result.display_name ?? null,
    city: address?.city ?? address?.town ?? address?.village ?? null,
    state: address?.state ?? null,
    country: address?.country ?? null,
    countryCode: address?.country_code ? address.country_code.toUpperCase() : null,
    postalCode: address?.postcode ?? null,
    category: result.type ?? result.category ?? null,
    sourceRef: result.place_id !== undefined ? String(result.place_id) : null,
    // No `existingPlaceId` — an OSM candidate is never an existing local
    // row; the caller creates one (../places.ts's `createPlace`) if picked.
  };
}

interface CacheEntry {
  expiresAt: number;
  data: unknown;
}

export function createOsmPlaceProvider(options: OsmPlaceProviderOptions): PlaceProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, CacheEntry>();
  let lastRequestAt = 0;

  function cacheGet(key: string): unknown {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  function cacheSet(key: string, data: unknown): void {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  /**
   * Returns `undefined` on any degrade path (rate-limited, network error,
   * non-2xx, timeout) — the caller treats `undefined` the same as "no
   * data," never as an exception to propagate.
   */
  async function cachedRequest(url: string): Promise<unknown> {
    const cached = cacheGet(url);
    if (cached !== undefined) return cached;

    if (Date.now() - lastRequestAt < MIN_REQUEST_INTERVAL_MS) {
      // Politely skip rather than queue/block — a caller composing this
      // with the manual provider should degrade immediately, not stall a
      // check-in flow waiting on Nominatim's rate window.
      return undefined;
    }
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const data: unknown = await res.json();
      cacheSet(url, data);
      return data;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async search(query, near) {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];

      const params = new URLSearchParams({
        q: trimmed,
        format: 'jsonv2',
        addressdetails: '1',
        limit: '10',
      });
      if (near) {
        // A generous bias box (~55km at the equator), not a hard filter —
        // no `bounded=1`, so a well-known place just outside it still
        // surfaces.
        const delta = 0.5;
        params.set(
          'viewbox',
          `${near.lng - delta},${near.lat + delta},${near.lng + delta},${near.lat - delta}`,
        );
      }

      const data = await cachedRequest(`${baseUrl}/search?${params.toString()}`);
      if (!Array.isArray(data)) return [];
      const candidates: PlaceCandidate[] = [];
      for (const entry of data as unknown[]) {
        const candidate = mapResult(entry as NominatimResult);
        if (candidate) candidates.push(candidate);
      }
      return candidates;
    },

    async reverseGeocode(lat, lng) {
      const params = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        format: 'jsonv2',
        addressdetails: '1',
      });
      const data = await cachedRequest(`${baseUrl}/reverse?${params.toString()}`);
      if (!data || typeof data !== 'object') return null;
      return mapResult(data as NominatimResult);
    },
  };
}
