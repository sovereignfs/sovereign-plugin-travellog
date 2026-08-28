import { describe, expect, it } from 'vitest';
import { resolveTimezoneFromCoords } from '../geo-timezone';

describe('resolveTimezoneFromCoords (T.20)', () => {
  it('resolves real-world coordinates to the correct IANA zone', () => {
    expect(resolveTimezoneFromCoords(38.7223, -9.1393)).toBe('Europe/Lisbon');
    expect(resolveTimezoneFromCoords(35.6762, 139.6503)).toBe('Asia/Tokyo');
    expect(resolveTimezoneFromCoords(40.7128, -74.006)).toBe('America/New_York');
  });

  it('returns null when either coordinate is missing — never guesses', () => {
    expect(resolveTimezoneFromCoords(null, -9.1393)).toBeNull();
    expect(resolveTimezoneFromCoords(38.7223, null)).toBeNull();
    expect(resolveTimezoneFromCoords(null, null)).toBeNull();
  });

  it('returns null instead of throwing on out-of-range coordinates', () => {
    expect(resolveTimezoneFromCoords(999, 999)).toBeNull();
  });
});
