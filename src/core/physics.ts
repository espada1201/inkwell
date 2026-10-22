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

/** Surface distance a wave of this speed has reached `tS` seconds after origin at this depth. */
export function waveRadiusKm(speedKms: number, tS: number, depthKm: number): number {
  return Math.sqrt(Math.max(0, (speedKms * tS) ** 2 - depthKm ** 2));
}

/** log10 PGA gained per magnitude unit, and lost per log10 of (distance + 10 km). */
const MAG_SCALE = 0.3;
const ATTENUATION = 1.5;

/** Peak ground acceleration in m/s² for magnitude M at hypocentral distance R. */
export function pgaFor(mag: number, rKm: number): number {
  return G * 10 ** (MAG_SCALE * mag - ATTENUATION * Math.log10(rKm + 10) - 0.5);
}

/** Invert pgaFor for a single station. */
export function magnitudeFrom(pga: number, rKm: number): number {
  return (Math.log10(pga / G) + ATTENUATION * Math.log10(rKm + 10) + 0.5) / MAG_SCALE;
}

/** Invert pgaFor for distance: the hypocentral distance, km, at which magnitude M shakes the ground this hard. */
export function distanceFor(mag: number, pga: number): number {
  return 10 ** ((MAG_SCALE * mag - 0.5 - Math.log10(pga / G)) / ATTENUATION) - 10;
}

/**
 * How much less likely a source becomes with distance, per unit of ln(R + 10 km). Shaking the
 * same phones as hard from farther away takes a bigger quake (ATTENUATION / MAG_SCALE magnitude
 * units per tenfold distance), and each magnitude unit is about ten times rarer
 * (Gutenberg–Richter, b ≈ 1), so the prior probability falls as (R + 10)^-5.
 */
export const DISTANCE_PRIOR = ATTENUATION / MAG_SCALE;

/** Felt intensity (rough Modified Mercalli mapping from PGA): thresholds in g. */
const MMI_G = [0.0017, 0.014, 0.039, 0.092, 0.18, 0.34];

export const WEAK = 1;
export const LIGHT = 2;
export const MODERATE = 3;

/** 0 = not felt, 1 weak, 2 light, 3 moderate, 4 strong, 5 very strong, 6 severe. */
export function intensityLevel(pga: number): number {
  const g = pga / G;
  let k = 0;
  while (k < MMI_G.length && g >= MMI_G[k]) k++;
  return k;
}

/** Quakes below about M2.5 are usually not felt, yet the shaking model, made for bigger ones, puts small ones close by at light or more. */
const FELT_MAG = 2.5;

/** How hard a quake shook a place this far from its epicentre, as `intensityLevel` counts: weak at most below about M2.5. */
export function shakingLevel(mag: number, epicentralKm: number, depthKm?: number): number {
  const level = intensityLevel(pgaFor(mag, hypocentralKm(epicentralKm, depthKm)));
  return mag < FELT_MAG ? Math.min(level, WEAK) : level;
}
