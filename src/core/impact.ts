import { distanceKm, offset, type LatLon } from './geo';
import { VS_KMS, hypocentralKm, intensityLevel, waveRadiusKm } from './physics';
import { upperMedian } from './stats';

/**
 * What a declared quake means on the ground.
 *  - Warning time: seconds between the network's alert reaching a phone and the strong
 *    S-wave shaking arriving there. Inside the blind zone the shaking wins the race.
 *  - Shaking map: the peak accelerations phones actually measured, interpolated onto a grid,
 *    so you see how hard the ground shook where people are, not just where the fault broke.
 */

/** Surface distance at which the S wave arrives `tS` seconds after origin. */
export const sRadiusKm = (tS: number, depthKm: number) => waveRadiusKm(VS_KMS, tS, depthKm);

export interface WarningSummary {
  /** Seconds after origin the alert reached phones. */
  alertAt: number;
  blindKm: number;
  /** Warning per phone that felt at least light shaking; negative = shaking came first. */
  warnings: number[];
  warned: number;
  median: number | null;
}

export function warningSummary(phones: (LatLon & { pga: number })[], epicentre: LatLon, depthKm: number, alertAt: number): WarningSummary {
  const warnings = phones
    .filter((p) => intensityLevel(p.pga) >= 2)
    .map((p) => hypocentralKm(distanceKm(epicentre, p), depthKm) / VS_KMS - alertAt);
  const pos = warnings.filter((w) => w > 0);
  return {
    alertAt,
    blindKm: sRadiusKm(alertAt, depthKm),
    warnings,
    warned: pos.length,
    median: upperMedian(pos),
  };
}

export interface ShakeCell extends LatLon {
  pga: number;
  level: number;
  /** Half the cell size, km, for drawing. */
  halfKm: number;
}

/**
 * Inverse-distance-weighted (power 2, in log-PGA) shaking grid from phone measurements.
 * Cells further than `reachKm` from every phone stay empty: no data, no colour.
 */
export function shakeGrid(points: (LatLon & { pga: number })[], cellKm = 3, reachKm = 15): ShakeCell[] {
  if (!points.length) return [];
  const c = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lon: points.reduce((s, p) => s + p.lon, 0) / points.length };
  const span = Math.max(...points.map((p) => distanceKm(c, p))) + reachKm;
  const cells: ShakeCell[] = [];
  for (let e = -span; e <= span; e += cellKm) {
    for (let n = -span; n <= span; n += cellKm) {
      const q = offset(c, e, n);
      let wsum = 0;
      let lsum = 0;
      let exact: number | null = null;
      for (const p of points) {
        const d = distanceKm(q, p);
        if (d > reachKm) continue;
        if (d < 0.05) exact = p.pga;
        const w = 1 / (d * d + 1);
        wsum += w;
        lsum += w * Math.log(p.pga);
      }
      if (!wsum) continue;
      const pga = exact ?? Math.exp(lsum / wsum);
      cells.push({ ...q, pga, level: intensityLevel(pga), halfKm: cellKm / 2 });
    }
  }
  return cells;
}
