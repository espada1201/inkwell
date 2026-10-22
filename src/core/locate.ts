import { distanceKm, offset, type LatLon } from './geo';
import { DEFAULT_DEPTH_KM, DISTANCE_PRIOR, hypocentralKm, magnitudeFrom, speedOf, type Phase } from './physics';
import { median } from './stats';

export interface Arrival extends LatLon {
  /** Arrival (trigger onset) in seconds on any common clock. */
  t: number;
  /** The wave that arrived; P when not given. */
  phase?: Phase;
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
  depthKm?: number;
  outlierS?: number;
  minArrivals?: number;
  maxOutliers?: number;
  /**
   * "Not yet arrived" constraint for early locations: nodes that are listening but have not
   * picked. A trial epicentre is penalised when it implies such a node should already have
   * felt a wave by `now` (same clock as t): the P wave if it is closer than the farthest
   * phone that picked a P, else the S wave if closer than the farthest that picked an S.
   */
  silent?: LatLon[];
  now?: number;
  /** Seconds of grace before a silent node counts against a trial epicentre. */
  silentSlackS?: number;
}

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
 * Coarse rings around the phones → two refinements, then outlier rejection.
 */
export function locate(arrivals: Arrival[], opts: LocateOptions = {}): Solution | null {
  const depth = opts.depthKm ?? DEFAULT_DEPTH_KM;
  const outlier = opts.outlierS ?? 2.5;
  const minN = opts.minArrivals ?? 3;
  if (arrivals.length < minN) return null;

  let used = arrivals.map((_, i) => i);
  let best = search(arrivals, depth, opts);
  const maxOut = opts.maxOutliers ?? 2;
  let dropped = 0;
  while (dropped < maxOut) {
    const bad = used.map((_, k) => k).filter((k) => Math.abs(best.res[k]) > outlier);
    bad.sort((a, b) => Math.abs(best.res[b]) - Math.abs(best.res[a]));
    // Dozens of arrivals pin the epicentre well enough to drop every bad clock at once; a
    // handful could be dragged by one, so they lose the worst and try again.
    const drop = new Set(bad.slice(0, used.length > 20 ? maxOut - dropped : 1));
    if (!drop.size || used.length - drop.size < minN) break;
    used = used.filter((_, k) => !drop.has(k));
    dropped += drop.size;
    best = search(
      used.map((i) => arrivals[i]),
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

/**
 * Silent phones pooled into cells of this size, each weighted by its count. Positions move by
 * at most ~2 km (a third of a second of P travel, well inside the slack), and a dense city's
 * thousand silent phones become ~150 terms.
 */
const SILENT_CELL_KM = 3;

function pooled(f: Frame, pts: LatLon[]) {
  const { x, y } = toXY(f, pts);
  if (pts.length <= 100) return { x, y, w: new Float64Array(pts.length).fill(1) };
  const cells = new Map<string, [number, number, number]>();
  for (let i = 0; i < pts.length; i++) {
    const key = `${Math.floor(x[i] / SILENT_CELL_KM)},${Math.floor(y[i] / SILENT_CELL_KM)}`;
    const c = cells.get(key);
    if (c) {
      c[0] += x[i];
      c[1] += y[i];
      c[2]++;
    } else cells.set(key, [x[i], y[i], 1]);
  }
  const list = [...cells.values()];
  return {
    x: Float64Array.from(list, (c) => c[0] / c[2]),
    y: Float64Array.from(list, (c) => c[1] / c[2]),
    w: Float64Array.from(list, (c) => c[2]),
  };
}

/** How far beyond the phones the search looks, km, and how its rings thin out with distance. */
const RANGE_ONE_WAVE_KM = 80;
const RANGE_TWO_WAVES_KM = 250;
const RING_RATIO = 0.07;

/** Typical size of one phone's timing error (clock and pick), s: it scales the distance prior. */
const TIMING_S = 0.12;
const PRIOR_S = TIMING_S * DISTANCE_PRIOR;

/** Grid misfits use at most this many arrivals: a few dozen pin an epicentre as well as a thousand. */
const MAX_GRID_ARRIVALS = 40;

/** An even sample across the arrival times, earliest and latest included. */
function spread(arr: Arrival[], k: number): Arrival[] {
  const byTime = [...arr].sort((a, b) => a.t - b.t);
  return Array.from({ length: k }, (_, i) => byTime[Math.round((i * (byTime.length - 1)) / (k - 1))]);
}

function search(all: Arrival[], depth: number, opts: LocateOptions) {
  const arr = all.length > MAX_GRID_ARRIVALS ? spread(all, MAX_GRID_ARRIVALS) : all;
  const f = frame(arr);
  const A = toXY(f, arr);
  const t = Float64Array.from(arr, (a) => a.t);
  const v = Float64Array.from(arr, (a) => speedOf(a.phase));
  const isS = arr.map((a) => a.phase === 'S');
  const vp = speedOf('P');
  const vs = speedOf('S');
  const S = pooled(f, opts.silent ?? []);
  const useSilent = S.x.length > 0 && opts.now !== undefined;
  const deadline = (opts.now ?? 0) - (opts.silentSlackS ?? 1.5);
  const z2 = depth * depth;
  const n = arr.length;
  const r = new Float64Array(n);

  // The misfit is the L1 timing error plus the distance prior in the same units: phones close
  // together cannot time a wavefront's curvature, and without the prior a quake under them
  // drifts to wherever the noise fits best, tens of km away with an inflated magnitude.
  // Costs only grow term by term, so summing stops as soon as a trial point is already worse
  // than the best so far: exact, and most grid points are far from the best.
  const misfit = (px: number, py: number, bound = Infinity) => {
    let farP2 = -1;
    let farS2 = -1;
    let sumHyp = 0;
    for (let i = 0; i < n; i++) {
      const dx = px - A.x[i];
      const dy = py - A.y[i];
      const d2 = dx * dx + dy * dy;
      if (isS[i]) farS2 = Math.max(farS2, d2);
      else farP2 = Math.max(farP2, d2);
      const hyp = Math.sqrt(d2 + z2);
      sumHyp += hyp;
      r[i] = t[i] - hyp / v[i];
    }
    const t0 = quickMedian(r, n);
    let cost = PRIOR_S * Math.log(sumHyp / n + 10);
    for (let i = 0; i < n && cost < bound; i++) cost += Math.abs(r[i] - t0);
    if (useSilent && cost < bound) {
      for (let k = 0; k < S.x.length && cost < bound; k++) {
        const dx = px - S.x[k];
        const dy = py - S.y[k];
        const d2 = dx * dx + dy * dy;
        const speed = d2 < farP2 ? vp : d2 < farS2 ? vs : 0;
        if (!speed) continue;
        const late = deadline - (t0 + Math.sqrt(d2 + z2) / speed);
        if (late > 0) cost += S.w[k] * Math.min(late, 5);
      }
    }
    return { cost, t0 };
  };

  let extent = 0;
  for (let i = 0; i < n; i++) extent = Math.max(extent, Math.hypot(A.x[i], A.y[i]));
  let best = { x: 0, y: 0, ...misfit(0, 0) };
  const at = (x: number, y: number) => {
    const c = misfit(x, y, best.cost);
    if (c.cost < best.cost) best = { x, y, ...c };
  };
  // Coarse: rings around the network, spaced in proportion to their distance, because a
  // distant quake is only ever placed to within a few per cent of its distance anyway. Seen in
  // one wave only, distance trades off against origin time, so the search stays closer in.
  const range = extent + (isS.includes(true) && isS.includes(false) ? RANGE_TWO_WAVES_KM : RANGE_ONE_WAVE_KM);
  const spacing = (r: number) => Math.max(2, RING_RATIO * r);
  for (let r = spacing(0); r <= range; r += spacing(r)) {
    const k = Math.ceil((2 * Math.PI * r) / spacing(r));
    for (let j = 0; j < k; j++) at(r * Math.cos((2 * Math.PI * j) / k), r * Math.sin((2 * Math.PI * j) / k));
  }
  // Then two finer square grids around the best point.
  let half = 1.5 * spacing(Math.hypot(best.x, best.y));
  for (let level = 0; level < 2; level++) {
    const cx = best.x;
    const cy = best.y;
    const step = half / 10;
    for (let e = -10; e <= 10; e++) for (let m = -10; m <= 10; m++) at(cx + e * step, cy + m * step);
    half = 2 * step;
  }
  const p = offset(f.origin, best.x, best.y);
  const res = all.map((a) => a.t - hypocentralKm(distanceKm(p, a), depth) / speedOf(a.phase));
  const t0 = median(res);
  return { p, t0, res: res.map((x) => x - t0) };
}
