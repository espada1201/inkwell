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

/** Felt intensity label (rough Modified Mercalli mapping from PGA). */
export function intensity(pga: number): string {
  const g = pga / G;
  if (g < 0.0017) return 'not felt';
  if (g < 0.014) return 'weak';
  if (g < 0.039) return 'light';
  if (g < 0.092) return 'moderate';
  if (g < 0.18) return 'strong';
  if (g < 0.34) return 'very strong';
  return 'severe';
}
