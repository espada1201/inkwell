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

export interface Uncertainty {
  /**
   * The epicentre lies within this many km of the solution about nine times in ten: as far as the
   * farthest point where the arrival times fit nearly as well, whatever the distance prior prefers.
   */
  km: number;
  /** The times fit about as well as far out as the search goes, so the quake may be farther still. */
  mayBeFarther: boolean;
  /** Magnitudes across that region, smallest first, or null without shaking amplitudes. */
  mag: [number, number] | null;
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
  const origin = {
    lat: points.reduce((s, a) => s + a.lat, 0) / points.length,
    lon: points.reduce((s, a) => s + a.lon, 0) / points.length,
  };
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
/**
 * Half the strength the Gutenberg–Richter argument behind DISTANCE_PRIOR gives. In a seeded sweep
 * of networks and distances, that placed quakes outside a small network 3–10 km nearer the truth,
 * for about 1 km worse on a quake right under four phones a few km apart. Either way a quake
 * outside a small network is placed poorly, which is what `uncertainty` owns up to.
 */
const PRIOR_S = (TIMING_S * DISTANCE_PRIOR) / 2;

/** Grid misfits use at most this many arrivals: a few dozen pin an epicentre as well as a thousand. */
const MAX_GRID_ARRIVALS = 40;

/** An even sample across the arrival times, earliest and latest included. */
function spread(arr: Arrival[], k: number): Arrival[] {
  const byTime = [...arr].sort((a, b) => a.t - b.t);
  return Array.from({ length: k }, (_, i) => byTime[Math.round((i * (byTime.length - 1)) / (k - 1))]);
}

/** The arrivals on a flat local grid, the misfit of a trial epicentre there, and how far to look. */
function problem(all: Arrival[], depth: number, opts: LocateOptions) {
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
  // than the bound: exact, and most grid points are far from the best.
  const misfit = (px: number, py: number, bound = Infinity, prior = true) => {
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
    let cost = prior ? PRIOR_S * Math.log(sumHyp / n + 10) : 0;
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
  // Seen in one wave only, distance trades off against origin time, so the search stays closer in.
  const range = extent + (isS.includes(true) && isS.includes(false) ? RANGE_TWO_WAVES_KM : RANGE_ONE_WAVE_KM);
  return { f, n, misfit, range };
}

/**
 * Rings around the network are spaced in proportion to their distance, because a distant quake
 * is only ever placed to within a few per cent of its distance anyway.
 */
const spacing = (r: number) => Math.max(2, RING_RATIO * r);

function search(all: Arrival[], depth: number, opts: LocateOptions) {
  const { f, misfit, range } = problem(all, depth, opts);
  let best = { x: 0, y: 0, ...misfit(0, 0) };
  const at = (x: number, y: number) => {
    const c = misfit(x, y, best.cost);
    if (c.cost < best.cost) best = { x, y, ...c };
  };
  // Coarse rings around the network, then two finer square grids around the best point.
  for (let r = spacing(0); r <= range; r += spacing(r)) {
    const k = Math.ceil((2 * Math.PI * r) / spacing(r));
    for (let j = 0; j < k; j++) at(r * Math.cos((2 * Math.PI * j) / k), r * Math.sin((2 * Math.PI * j) / k));
  }
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

/**
 * A point fits the arrival times "nearly as well" as the best one when its timing misfit is within
 * this many error scales: the 90% likelihood-ratio region for an epicentre (half of χ² with two
 * degrees of freedom), with each phone's error taken as Laplace-distributed, as the L1 misfit does.
 */
const PLAUSIBLE = 2.3;
/** Phones publish their position to about a kilometre, so no epicentre is surer than that. */
const MIN_UNCERTAINTY_KM = 1;
/** Directions from the middle of the network along which the region is traced. */
const BEARINGS = 72;
/** Depths tried: real quakes are rarely as shallow as half the default or deeper than twice it. */
const DEPTHS_KM = [DEFAULT_DEPTH_KM / 2, DEFAULT_DEPTH_KM, 2 * DEFAULT_DEPTH_KM];
/** Golden-section steps that pin a minimum along a ray to well under a kilometre. */
const GOLDEN_STEPS = 14;

/**
 * How far off a solution could be, and how big the quake could then be. The region is every point
 * where the arrival times, the prior left out, fit within PLAUSIBLE error scales of the best fit at
 * any of DEPTHS_KM: the data alone cannot rule the epicentre out there. It is traced along rays
 * from the middle of the network, which follow both ways a small network goes wrong (it cannot
 * tell how far, or from which side), plus a fine grid around the solution for a tight fit. The
 * error scale is the assumed timing error, or the fit's own scatter when that is worse.
 */
export function uncertainty(arrivals: Arrival[], at: LatLon): Uncertainty {
  const probs = DEPTHS_KM.map((d) => problem(arrivals, d, {}));
  const { f, n, range } = probs[0];
  const radii = [0];
  for (let r = spacing(0); r <= range; r += spacing(r)) radii.push(r);
  const {
    x: [ax],
    y: [ay],
  } = toXY(f, [at]);

  // The lowest misfit along each ray, at each depth.
  const rays: { k: number; c: number; s: number; r: number; cost: number }[] = [];
  for (let k = 0; k < DEPTHS_KM.length; k++)
    for (let j = 0; j < BEARINGS; j++) {
      const c = Math.cos((2 * Math.PI * j) / BEARINGS);
      const s = Math.sin((2 * Math.PI * j) / BEARINGS);
      const m = (r: number, bound = Infinity) => probs[k].misfit(r * c, r * s, bound, false).cost;
      let i0 = 0;
      let low = m(0);
      for (let i = 1; i < radii.length; i++) {
        const v = m(radii[i], low);
        if (v < low) ((low = v), (i0 = i));
      }
      let a = radii[Math.max(0, i0 - 1)];
      let b = radii[Math.min(radii.length - 1, i0 + 1)];
      let r = radii[i0];
      const g = (Math.sqrt(5) - 1) / 2;
      let x1 = b - g * (b - a);
      let x2 = a + g * (b - a);
      let f1 = m(x1);
      let f2 = m(x2);
      for (let it = 0; it < GOLDEN_STEPS; it++) {
        if (f1 < f2) ((b = x2), (x2 = x1), (f2 = f1), (x1 = b - g * (b - a)), (f1 = m(x1)));
        else ((a = x1), (x1 = x2), (f1 = f2), (x2 = a + g * (b - a)), (f2 = m(x2)));
      }
      if (Math.min(f1, f2) < low) ((low = Math.min(f1, f2)), (r = f1 < f2 ? x1 : x2));
      rays.push({ k, c, s, r, cost: low });
    }
  // And a fine grid around the solution, as the search's first refinement has it.
  const step = 0.15 * spacing(Math.hypot(ax, ay));
  const fine: { k: number; x: number; y: number; cost: number }[] = [];
  for (let k = 0; k < DEPTHS_KM.length; k++)
    for (let e = -10; e <= 10; e++)
      for (let q = -10; q <= 10; q++)
        fine.push({
          k,
          x: ax + e * step,
          y: ay + q * step,
          cost: probs[k].misfit(ax + e * step, ay + q * step, Infinity, false).cost,
        });

  const best = Math.min(...rays.map((x) => x.cost), ...fine.map((x) => x.cost));
  const scale = Math.max(TIMING_S * Math.sqrt(2 / Math.PI), best / Math.max(1, n - 4));
  const top = best + PLAUSIBLE * scale;

  const shaken = arrivals.filter((a) => a.pga && a.pga > 0);
  const sample = shaken.length > MAX_GRID_ARRIVALS ? spread(shaken, MAX_GRID_ARRIVALS) : shaken;
  const P = toXY(f, sample);
  const logPga = sample.map((a) => Math.log10(a.pga!));
  const mags = new Float64Array(sample.length);
  let km = MIN_UNCERTAINTY_KM;
  let mayBeFarther = false;
  let lo = Infinity;
  let hi = -Infinity;
  const include = (x: number, y: number, k: number) => {
    km = Math.max(km, Math.hypot(x - ax, y - ay));
    if (!sample.length) return;
    for (let i = 0; i < sample.length; i++) mags[i] = magnitudeFrom(10 ** logPga[i], hypocentralKm(Math.hypot(x - P.x[i], y - P.y[i]), DEPTHS_KM[k]));
    const mag = quickMedian(mags, sample.length);
    lo = Math.min(lo, mag);
    hi = Math.max(hi, mag);
  };
  // The solution itself, at the depth it was located at, then every plausible point near it.
  include(ax, ay, DEPTHS_KM.indexOf(DEFAULT_DEPTH_KM));
  for (const p of fine) if (p.cost <= top) include(p.x, p.y, p.k);
  // Along each ray that holds a plausible point, out and in to where the fit gets too poor.
  for (const ray of rays) {
    if (ray.cost > top) continue;
    const m = (r: number) => probs[ray.k].misfit(r * ray.c, r * ray.s, top + 1, false).cost;
    const edge = (inside: number, outside: number) => {
      for (let it = 0; it < 10; it++) {
        const mid = (inside + outside) / 2;
        if (m(mid) <= top) inside = mid;
        else outside = mid;
      }
      return inside;
    };
    const out = radii.find((r) => r > ray.r && m(r) > top);
    const inn = [...radii].reverse().find((r) => r < ray.r && m(r) > top);
    const far = out === undefined ? range : edge(ray.r, out);
    const near = inn === undefined ? 0 : edge(ray.r, inn);
    mayBeFarther ||= out === undefined;
    for (const r of [near, ray.r, far]) include(r * ray.c, r * ray.s, ray.k);
  }
  return {
    km,
    mayBeFarther,
    mag: sample.length ? [+lo.toFixed(1), +hi.toFixed(1)] : null,
  };
}
