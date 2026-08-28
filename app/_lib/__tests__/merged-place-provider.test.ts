import { describe, expect, it, vi } from 'vitest';
import type { PlaceCandidate, PlaceProvider } from '../place-provider';
import { createMergedPlaceProvider } from '../providers/merged-place-provider';

function fakeProvider(
  searchResult: PlaceCandidate[],
  reverseResult: PlaceCandidate | null = null,
): PlaceProvider {
  return {
    search: vi.fn(async () => searchResult),
    reverseGeocode: vi.fn(async () => reverseResult),
  };
}

const localCandidate: PlaceCandidate = {
  name: 'Local Café',
  lat: 1,
  lng: 1,
  existingPlaceId: 'place-1',
};
const externalCandidate: PlaceCandidate = { name: 'External Café', lat: 2, lng: 2 };

describe('createMergedPlaceProvider', () => {
  it('concatenates results, primary first', async () => {
    const merged = createMergedPlaceProvider(
      fakeProvider([localCandidate]),
      fakeProvider([externalCandidate]),
    );
    expect(await merged.search('café')).toEqual([localCandidate, externalCandidate]);
  });

  it('still returns the secondary results when the primary has none', async () => {
    const merged = createMergedPlaceProvider(fakeProvider([]), fakeProvider([externalCandidate]));
    expect(await merged.search('café')).toEqual([externalCandidate]);
  });

  it('returns an empty array when neither provider matches', async () => {
    const merged = createMergedPlaceProvider(fakeProvider([]), fakeProvider([]));
    expect(await merged.search('nothing')).toEqual([]);
  });

  it('queries both providers concurrently, not sequentially', async () => {
    const primary = fakeProvider([localCandidate]);
    const secondary = fakeProvider([externalCandidate]);
    const merged = createMergedPlaceProvider(primary, secondary);

    await merged.search('café', { lat: 0, lng: 0 });

    expect(primary.search).toHaveBeenCalledWith('café', { lat: 0, lng: 0 });
    expect(secondary.search).toHaveBeenCalledWith('café', { lat: 0, lng: 0 });
  });

  it('reverseGeocode prefers the primary result, falling back to the secondary', async () => {
    const primaryHit = createMergedPlaceProvider(
      fakeProvider([], localCandidate),
      fakeProvider([], externalCandidate),
    );
    expect(await primaryHit.reverseGeocode(1, 1)).toEqual(localCandidate);

    const secondaryOnly = createMergedPlaceProvider(
      fakeProvider([], null),
      fakeProvider([], externalCandidate),
    );
    expect(await secondaryOnly.reverseGeocode(1, 1)).toEqual(externalCandidate);

    const neither = createMergedPlaceProvider(fakeProvider([], null), fakeProvider([], null));
    expect(await neither.reverseGeocode(1, 1)).toBeNull();
  });
});
