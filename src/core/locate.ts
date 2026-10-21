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

export interface LocateOptions {
  vp?: number;
  depthKm?: number;
  outlierS?: number;
  minArrivals?: number;
  maxOutliers?: number;
  /**
   * "Not yet arrived" constraint for early locations: nodes that are listening but have not
   * picked. A trial epicentre is penalised when it implies such a node, closer than the
   * farthest picking node, should already have felt the P wave by `now` (same clock as t).
   */
  silent?: LatLon[];
  now?: number;
  /** Seconds of grace before a silent node counts against a trial epicentre. */
  silentSlackS?: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Points projected to a local flat km grid: accurate enough over a few hundred km, and fast. */
interface Frame {
  origin: LatLon;
  kx: number;
}
function frame(points: LatLon[]): Frame {
  const origin = { lat: points.reduce((s, a) => s + a.lat, 0) / points.length, lon: points.reduce((s, a) => s + a.lon, 0) / points.length };
  return { origin, kx: 111.195 * Math.cos((origin.lat * Math.PI) / 180) };
}
function toXY(f: Frame, pts: LatLon[]) {
  const x = new Float64Array(pts.length);
  const y = new Float64Array(pts.length);
  pts.forEach((p, i) => {
    let dLon = p.lon - f.origin.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    x[i] = dLon * f.kx;
    y[i] = (p.lat - f.origin.lat) * 111.195;
  });
  return { x, y };
}

/** Median of the first n entries of a (reorders them). Quickselect: this runs in the inner loop. */
function quickMedian(a: Float64Array, n: number): number {
  const sel = (k: number) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) {
          const tmp = a[i];
          a[i] = a[j];
          a[j] = tmp;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return a[k];
    }
    return a[k];
  };
  const m = n >> 1;
  return n % 2 ? sel(m) : (sel(m - 1) + sel(m)) / 2;
}

/**
 * Epicentre by grid search on arrival times: for each trial point the origin time is the
 * median of (arrival − travel time), and the L1 misfit is robust to one or two bad clocks.
 * Coarse grid → two refinements, then outlier rejection one arrival at a time.
 */
export function locate(arrivals: Arrival[], opts: LocateOptions = {}): Solution | null {
  const vp = opts.vp ?? VP_KMS;
  const depth = opts.depthKm ?? DEFAULT_DEPTH_KM;
  const outlier = opts.outlierS ?? 2.5;
  const minN = opts.minArrivals ?? 3;
  if (arrivals.length < minN) return null;

  let used = arrivals.map((_, i) => i);
  let best = search(arrivals, vp, depth, opts);
  const maxOut = opts.maxOutliers ?? 2;
  for (let pass = 0; pass < maxOut; pass++) {
    const worst = best.res.reduce((w, r, i) => (Math.abs(r) > Math.abs(best.res[w]) ? i : w), 0);
    if (Math.abs(best.res[worst]) <= outlier || used.length - 1 < minN) break;
    used = used.filter((_, i) => i !== worst);
    best = search(
      used.map((i) => arrivals[i]),
      vp,
      depth,
      opts,
    );
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

function search(arr: Arrival[], vp: number, depth: number, opts: LocateOptions) {
  const f = frame(arr);
  const A = toXY(f, arr);
  const t = Float64Array.from(arr, (a) => a.t);
  const S = toXY(f, opts.silent ?? []);
  const useSilent = S.x.length > 0 && opts.now !== undefined;
  const deadline = (opts.now ?? 0) - (opts.silentSlackS ?? 1.5);
  const z2 = depth * depth;
  const n = arr.length;
  const r = new Float64Array(n);

  const misfit = (px: number, py: number) => {
    let far2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = px - A.x[i];
      const dy = py - A.y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > far2) far2 = d2;
      r[i] = t[i] - Math.sqrt(d2 + z2) / vp;
    }
    const t0 = quickMedian(r, n);
    let cost = 0;
    for (let i = 0; i < n; i++) cost += Math.abs(r[i] - t0);
    if (useSilent) {
      for (let k = 0; k < S.x.length; k++) {
        const dx = px - S.x[k];
        const dy = py - S.y[k];
        const d2 = dx * dx + dy * dy;
        if (d2 >= far2) continue;
        const late = deadline - (t0 + Math.sqrt(d2 + z2) / vp);
        if (late > 0) cost += Math.min(late, 5);
      }
    }
    return { cost, t0 };
  };

  let extent = 0;
  for (let i = 0; i < n; i++) extent = Math.max(extent, Math.hypot(A.x[i], A.y[i]));
  let cx = 0;
  let cy = 0;
  let half = Math.max(60, extent + 80);
  let step = half / 40;
  let best = { x: 0, y: 0, ...misfit(0, 0) };
  for (let level = 0; level < 3; level++) {
    for (let e = -half; e <= half + 1e-9; e += step) {
      for (let m = -half; m <= half + 1e-9; m += step) {
        const c = misfit(cx + e, cy + m);
        if (c.cost < best.cost) best = { x: cx + e, y: cy + m, ...c };
      }
    }
    cx = best.x;
    cy = best.y;
    half = step * 2;
    step = half / 20;
  }
  const p = offset(f.origin, best.x, best.y);
  const res = arr.map((a) => a.t - hypocentralKm(distanceKm(p, a), depth) / vp);
  const t0 = median(res);
  return { p, t0, res: res.map((x) => x - t0) };
}
