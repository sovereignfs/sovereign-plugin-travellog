import { describe, expect, it } from 'vitest';
import { distanceMeters } from '../geo';

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters({ lat: 38.7071, lng: -9.1355 }, { lat: 38.7071, lng: -9.1355 })).toBe(0);
  });

  it('matches the well-known ~111km per degree of latitude', () => {
    const lisbon = { lat: 38.7071, lng: -9.1355 };
    const oneDegreeNorth = { lat: 39.7071, lng: -9.1355 };
    const distance = distanceMeters(lisbon, oneDegreeNorth);
    expect(distance).toBeGreaterThan(110_000);
    expect(distance).toBeLessThan(112_000);
  });

  it('is symmetric', () => {
    const a = { lat: 38.7071, lng: -9.1355 };
    const b = { lat: 41.1579, lng: -8.6291 }; // Porto
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
  });
});
