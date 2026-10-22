export interface LatLon {
  lat: number;
  lon: number;
}

const R_EARTH_KM = 6371;
/** Kilometres in a degree of latitude, or of longitude at the equator. */
export const KM_PER_DEG = (R_EARTH_KM * Math.PI) / 180;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Move `km` east and north from a point (flat-earth; fine for the < 500 km spans we use). */
export function offset(p: LatLon, eastKm: number, northKm: number): LatLon {
  const lat = p.lat + (northKm / R_EARTH_KM) * (180 / Math.PI);
  const lon = p.lon + (eastKm / (R_EARTH_KM * Math.cos(rad(p.lat)))) * (180 / Math.PI);
  return { lat, lon: ((lon + 540) % 360) - 180 };
}

/** Privacy: nodes only ever publish coordinates snapped to a 0.01° grid (about 1.1 km). */
const COARSE_DEG = 0.01;
export function coarsen(p: LatLon): LatLon {
  const snap = (v: number) => Math.round(v / COARSE_DEG) * COARSE_DEG;
  return { lat: +snap(p.lat).toFixed(2), lon: +snap(p.lon).toFixed(2) };
}

/** The grid cell a point is published in. Phones that share one may share a building. */
export const cellOf = (p: LatLon) => `${Math.round(p.lat / COARSE_DEG)},${Math.round(p.lon / COARSE_DEG)}`;

/**
 * Typed coordinates, "37.80, -122.27" or "37.80 -122.27", or null for anything that would need a
 * guess: a decimal comma, compass letters, one number or three, or out of range.
 */
export function parseLatLon(text: string): LatLon | null {
  const m = text.match(/^\s*([-+]?\d*\.?\d+)\s*[,\s]\s*([-+]?\d*\.?\d+)\s*$/);
  if (!m) return null;
  const [lat, lon] = [Number(m[1]), Number(m[2])];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
