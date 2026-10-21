/**
 * Crustal wave speeds and a deliberately simple ground-motion relation.
 * The relation is a rough, generic PGA attenuation curve, calibrated to give
 * plausible felt-shaking levels; it is used both to synthesise demo scenarios
 * and (inverted) to estimate magnitude, so treat magnitudes as ±0.5–1 unit.
 */
export const VP_KMS = 6.0;
export const VS_KMS = 3.5;
export const DEFAULT_DEPTH_KM = 10;
export const G = 9.81;

export function hypocentralKm(epicentralKm: number, depthKm = DEFAULT_DEPTH_KM): number {
  return Math.hypot(epicentralKm, depthKm);
}

/** Peak ground acceleration in m/s² for magnitude M at hypocentral distance R. */
export function pgaFor(mag: number, rKm: number): number {
  return G * 10 ** (0.3 * mag - 1.5 * Math.log10(rKm + 10) - 0.5);
}

/** Invert pgaFor for a single station. */
export function magnitudeFrom(pga: number, rKm: number): number {
  return (Math.log10(pga / G) + 1.5 * Math.log10(rKm + 10) + 0.5) / 0.3;
}

/** Felt intensity (rough Modified Mercalli mapping from PGA): thresholds in g, and labels. */
const MMI_G = [0.0017, 0.014, 0.039, 0.092, 0.18, 0.34];
export const INTENSITY = ['not felt', 'weak', 'light', 'moderate', 'strong', 'very strong', 'severe'] as const;

/** 0 = not felt … 6 = severe. */
export function intensityLevel(pga: number): number {
  const g = pga / G;
  let k = 0;
  while (k < MMI_G.length && g >= MMI_G[k]) k++;
  return k;
}

export const intensity = (pga: number) => INTENSITY[intensityLevel(pga)];
