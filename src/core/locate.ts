import { distanceKm, offset, type LatLon } from './geo';
import { DEFAULT_DEPTH_KM, VP_KMS, hypocentralKm, magnitudeFrom } from './physics';

export interface Arrival extends LatLon {
  /** P arrival (trigger onset) in seconds on any common clock. */
  t: number;
  /** Peak acceleration seen by the node, m/s² (optional, for magnitude). */
  pga?: number;
}

export interface Solution extends LatLon {
  /** Origin time on the same clock as the arrivals. */
  t0: number;
  /** Root-mean-square travel-time residual, seconds. */
  rms: number;
  residuals: number[];
  /** Indices of arrivals used after outlier removal. */
  used: number[];
  mag: number | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function misfit(p: LatLon, arr: Arrival[], vp: number, depth: number) {
  const r = arr.map((a) => a.t - hypocentralKm(distanceKm(p, a), depth) / vp);
  const t0 = median(r);
  let cost = 0;
  for (const x of r) cost += Math.abs(x - t0);
  return { cost, t0, res: r.map((x) => x - t0) };
}

/**
 * Epicentre by grid search on arrival times: for each trial point the origin time is the
 * median of (arrival − travel time), and the L1 misfit is robust to one or two bad clocks.
 * Coarse grid → two refinements, then outlier rejection one arrival at a time.
 */
export function locate(
  arrivals: Arrival[],
  opts: { vp?: number; depthKm?: number; outlierS?: number; minArrivals?: number; maxOutliers?: number } = {},
): Solution | null {
  const vp = opts.vp ?? VP_KMS;
  const depth = opts.depthKm ?? DEFAULT_DEPTH_KM;
  const outlier = opts.outlierS ?? 2.5;
  const minN = opts.minArrivals ?? 3;
  if (arrivals.length < minN) return null;

  let used = arrivals.map((_, i) => i);
  let best = search(arrivals, vp, depth);
  const maxOut = opts.maxOutliers ?? 2;
  for (let pass = 0; pass < maxOut; pass++) {
    const worst = best.res.reduce((w, r, i) => (Math.abs(r) > Math.abs(best.res[w]) ? i : w), 0);
    if (Math.abs(best.res[worst]) <= outlier || used.length - 1 < minN) break;
    used = used.filter((_, i) => i !== worst);
    best = search(used.map((i) => arrivals[i]), vp, depth);
  }
  const rms = Math.sqrt(best.res.reduce((s, r) => s + r * r, 0) / best.res.length);
  const mags = used
    .map((i) => arrivals[i])
    .filter((a) => a.pga && a.pga > 0)
    .map((a) => magnitudeFrom(a.pga!, hypocentralKm(distanceKm(best.p, a), depth)));
  return {
    ...best.p,
    t0: best.t0,
    rms,
    residuals: best.res,
    used,
    mag: mags.length ? +median(mags).toFixed(1) : null,
  };
}

function search(arr: Arrival[], vp: number, depth: number) {
  const c = { lat: arr.reduce((s, a) => s + a.lat, 0) / arr.length, lon: arr.reduce((s, a) => s + a.lon, 0) / arr.length };
  const extent = Math.max(...arr.map((a) => distanceKm(c, a)));
  let center = c;
  let half = Math.max(60, extent + 80);
  let step = half / 40;
  let best = { p: c, ...misfit(c, arr, vp, depth) };
  for (let level = 0; level < 3; level++) {
    for (let e = -half; e <= half + 1e-9; e += step) {
      for (let n = -half; n <= half + 1e-9; n += step) {
        const p = offset(center, e, n);
        const m = misfit(p, arr, vp, depth);
        if (m.cost < best.cost) best = { p, ...m };
      }
    }
    center = best.p;
    half = step * 2;
    step = half / 20;
  }
  return best;
}
