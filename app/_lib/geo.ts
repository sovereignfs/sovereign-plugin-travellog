/**
 * Great-circle distance between two coordinates, in meters (haversine).
 * Used now to bias place search toward nearby results when the caller has
 * a current position; reused as-is for the deferred Phase 2a proximity
 * reordering in Trip Mode (CONCEPT.md's "Future (deferred)" section) —
 * that tier needs exactly this, no routing engine.
 */
export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}
