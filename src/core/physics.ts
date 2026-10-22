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

/** Which wave a phone triggered on: P (first, compressional) or S (later, stronger, shear). */
export type Phase = 'P' | 'S';
export const speedOf = (phase: Phase | undefined) => (phase === 'S' ? VS_KMS : VP_KMS);

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

/** Felt intensity (rough Modified Mercalli mapping from PGA): thresholds in g. */
const MMI_G = [0.0017, 0.014, 0.039, 0.092, 0.18, 0.34];

/** 0 = not felt, 1 weak, 2 light, 3 moderate, 4 strong, 5 very strong, 6 severe. */
export function intensityLevel(pga: number): number {
  const g = pga / G;
  let k = 0;
  while (k < MMI_G.length && g >= MMI_G[k]) k++;
  return k;
}
