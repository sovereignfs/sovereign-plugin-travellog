/**
 * `createOsmPlaceProvider`'s own behavior: response mapping, caching, and
 * the rate-limit degrade path (SPEC.md's T.3a review checklist: "hitting
 * the provider's rate limit degrades... without erroring"). `fetchImpl` is
 * injected throughout — never a real network call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOsmPlaceProvider } from '../providers/osm-place-provider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sampleResult = {
  place_id: 12345,
  lat: '38.6916',
  lon: '-9.2159',
  display_name: 'Belém Tower, Avenida Brasília, Lisbon, Portugal',
  type: 'attraction',
  address: {
    city: 'Lisbon',
    state: 'Lisbon',
    country: 'Portugal',
    country_code: 'pt',
    postcode: '1400-038',
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createOsmPlaceProvider', () => {
  it('maps a Nominatim search result to a PlaceCandidate', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleResult]));
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    const results = await provider.search('Belém Tower');
    expect(results).toEqual([
      {
        name: 'Belém Tower',
        lat: 38.6916,
        lng: -9.2159,
        address: sampleResult.display_name,
        city: 'Lisbon',
        state: 'Lisbon',
        country: 'Portugal',
        countryCode: 'PT',
        postalCode: '1400-038',
        category: 'attraction',
        sourceRef: '12345',
      },
    ]);
  });

  it('sends a real identifying User-Agent header (Nominatim usage policy)', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    await provider.search('anything');

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('User-Agent')).toMatch(/SovereignTravellog/);
  });

  it('biases with a viewbox when a current position is given', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    );
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    await provider.search('cafe', { lat: 38.7071, lng: -9.1355 });

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toMatch(/viewbox=/);
  });

  it('returns [] on a non-2xx response, never throws', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad request' }, 400));
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    await expect(provider.search('anything')).resolves.toEqual([]);
  });

  it('returns [] on a network error, never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    await expect(provider.search('anything')).resolves.toEqual([]);
  });

  it('reverseGeocode maps a single result, and returns null for a malformed one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(sampleResult));
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    const result = await provider.reverseGeocode(38.6916, -9.2159);
    expect(result).toMatchObject({ name: 'Belém Tower', lat: 38.6916, lng: -9.2159 });

    const emptyFetch = vi.fn(async () => jsonResponse(null));
    const emptyProvider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl: emptyFetch });
    expect(await emptyProvider.reverseGeocode(0, 0)).toBeNull();
  });

  it('caches an identical request — a repeat search does not call fetch again', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleResult]));
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    await provider.search('Belém Tower');
    await provider.search('Belém Tower');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rate-limits: a different query within the 1 req/s window degrades to [] without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([sampleResult]));
    const provider = createOsmPlaceProvider({ baseUrl: 'https://nominatim.test', fetchImpl });

    const first = await provider.search('Belém Tower');
    expect(first).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Different query (not a cache hit), same instant — must not exceed 1 req/s.
    const second = await provider.search('Pastéis de Belém');
    expect(second).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Once the window passes, the same query is allowed through again.
    vi.advanceTimersByTime(1200);
    const third = await provider.search('Pastéis de Belém');
    expect(third).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
