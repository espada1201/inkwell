import { KM_PER_DEG, distanceKm, type LatLon } from './geo';
import { locate, uncertainty, type Arrival, type Solution, type Uncertainty } from './locate';
import { VP_KMS, VS_KMS, hypocentralKm, speedOf, type Phase } from './physics';

export interface Trigger extends LatLon {
  id: string;
  node: string;
  /** Onset time, ms since epoch. */
  t: number;
  /** Peak acceleration, m/s². */
  pga: number;
  /** The wave the phone triggered on; P when not given. */
  phase?: Phase;
  /** A confirmed trigger's own pick, by id, when the phone names the pick it settles. */
  pick?: string;
}

export interface DetectedEvent extends Solution {
  id: string;
  /** Origin time, ms since epoch. */
  time: number;
  triggers: Trigger[];
}

export interface AssociateOptions {
  minNodes?: number;
  maxRmsS?: number;
}

/** Slack allowed beyond the travel time between two phones' triggers, s: phone clocks drift. */
const TOLERANCE_S = 1.5;
const MAX_DISTANCE_KM = 400;
/** Two points this many degrees apart or less, in latitude and in longitude, are within MAX_DISTANCE_KM. */
const NEAR_DEG = MAX_DISTANCE_KM / (Math.SQRT2 * KM_PER_DEG);
const MAX_SPAN_S = 90;

export interface Sphere {
  cosLat: number;
  sinLat2: number;
  cosLat2: number;
  sinLon2: number;
  cosLon2: number;
}
export function onSphere(p: LatLon): Sphere {
  const lat = (p.lat * Math.PI) / 180;
  const lon = (p.lon * Math.PI) / 180;
  return { cosLat: Math.cos(lat), sinLat2: Math.sin(lat / 2), cosLat2: Math.cos(lat / 2), sinLon2: Math.sin(lon / 2), cosLon2: Math.cos(lon / 2) };
}

const TWO_R_KM = (2 * 180 * KM_PER_DEG) / Math.PI;
/** The chord-based distance below the great-circle one (asin x ≥ x), and the most it can fall short by under MAX_DISTANCE_KM (x/6 of x²), with room to spare. */
const SHORT_BY = 1.001;

/**
 * `d <= MAX_DISTANCE_KM && dt <= d / speed + TOLERANCE_S` for the great-circle distance d, as
 * `distanceKm` gives it. Products of half-angle sines give d to within 0.1% without a single
 * trigonometric call, and only a pair that bound cannot settle pays for the exact distance.
 */
export function compatible(a: LatLon, b: LatLon, pa: Sphere, pb: Sphere, dt: number, speed: number): boolean {
  const sLat = pb.sinLat2 * pa.cosLat2 - pb.cosLat2 * pa.sinLat2;
  const sLon = pb.sinLon2 * pa.cosLon2 - pb.cosLon2 * pa.sinLon2;
  const near = TWO_R_KM * Math.sqrt(sLat * sLat + pa.cosLat * pb.cosLat * sLon * sLon);
  if (near > MAX_DISTANCE_KM) return false;
  const far = near * SHORT_BY;
  if (far <= MAX_DISTANCE_KM) {
    if (dt <= near / speed + TOLERANCE_S) return true;
    if (dt > far / speed + TOLERANCE_S) return false;
  }
  const d = distanceKm(a, b);
  return d <= MAX_DISTANCE_KM && dt <= d / speed + TOLERANCE_S;
}

/**
 * Recent cluster solutions. Callers re-associate nearly the same triggers several times a
 * second while a quake or a busy minute unfolds, and most clusters come round again unchanged.
 */
const solved = new Map<string, Solution | null>();
const SOLVED_MAX = 2000;

/** Triggers as arrivals to locate, in seconds after the first. */
export function toArrivals(triggers: Trigger[]): Arrival[] {
  const ref = triggers[0].t;
  return triggers.map((c) => ({ lat: c.lat, lon: c.lon, t: (c.t - ref) / 1000, pga: c.pga, phase: c.phase }));
}

function locateCached(members: Trigger[], minNodes: number): Solution | null {
  const key = members.length <= 64 ? `${minNodes}|${members.map((c) => `${c.id},${c.t},${c.lat},${c.lon},${c.pga},${c.phase}`).join(';')}` : null;
  if (key !== null && solved.has(key)) return solved.get(key)!;
  const sol = locate(toArrivals(members), { minArrivals: minNodes, maxOutliers: Math.floor(members.length * 0.3) });
  if (key !== null) {
    solved.set(key, sol);
    if (solved.size > SOLVED_MAX) solved.delete(solved.keys().next().value!);
  }
  return sol;
}

const byOnsetThenId = (a: Trigger, b: Trigger) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const popcount32 = (bits: number) => {
  bits -= (bits >>> 1) & 0x55555555;
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

const lastAnswer = new Map<string, { input: Trigger[]; events: DetectedEvent[] }>();

/**
 * Space–time association. Two triggers of the same wave can belong to one earthquake only if
 * their time difference is no larger than that wave's travel time between the nodes (plus slack).
 *  1. From every unused trigger, grow a cluster of pairwise-compatible triggers (one per node).
 *  2. Locate the largest cluster by grid search, dropping bad clocks. One wave needs minNodes
 *     phones; a cluster one phone short only counts together with the other wave.
 *  3. Try adding the largest cluster of the other wave: from outside the network a quake's
 *     distance trades off against its origin time, and the gap between its P and S arrivals is
 *     what pins it.
 *  4. Re-gather every unused trigger the solution explains as an arrival of its own wave, and
 *     relocate, so an unlucky seed (e.g. a stray footstep) cannot bias membership.
 *  5. Later triggers the event explains as either wave are absorbed so they do not spawn ghosts.
 */
function associateAll(triggers: Trigger[], opts: AssociateOptions): DetectedEvent[] {
  const minNodes = opts.minNodes ?? 4;
  const maxSpan = MAX_SPAN_S * 1000;
  const maxRms = opts.maxRmsS ?? 1.5;

  const sorted = [...triggers].sort(byOnsetThenId);
  const used = new Set<string>();
  const deadSeeds = new Set<string>();
  const events: DetectedEvent[] = [];

  // Pairwise compatibility as one bitset row per trigger, so growing a cluster costs a few
  // word-ANDs per member instead of a distance check against every member (a city of a
  // thousand phones would otherwise take seconds).
  const n = sorted.length;
  const words = (n + 31) >>> 5;
  const compat = new Uint32Array(n * words);
  const sphere = sorted.map(onSphere);
  for (let a = 0; a < n; a++) {
    const A = sorted[a];
    const phase = A.phase ?? 'P';
    const speed = speedOf(phase);
    for (let b = a + 1; b < n && sorted[b].t - A.t <= maxSpan; b++) {
      const B = sorted[b];
      if (phase !== (B.phase ?? 'P')) continue;
      const dt = (B.t - A.t) / 1000;
      const near = dt <= TOLERANCE_S && Math.abs(B.lat - A.lat) <= NEAR_DEG && Math.abs(B.lon - A.lon) <= NEAR_DEG;
      if (near || compatible(A, B, sphere[a], sphere[b], dt, speed)) {
        compat[a * words + (b >>> 5)] |= 1 << (b & 31);
      }
    }
  }

  const free = new Uint32Array(words);
  for (let i = 0; i < n; i++) free[i >>> 5] |= 1 << (i & 31);
  const index = new Map(sorted.map((t, i) => [t, i]));
  const use = (t: Trigger) => {
    used.add(t.id);
    const i = index.get(t)!;
    free[i >>> 5] &= ~(1 << (i & 31));
  };
  const maxClusterSize = (i: number) => {
    let count = 1;
    const first = (i + 1) >>> 5;
    for (let w = first; w < words; w++) {
      const bits = compat[i * words + w] & free[w];
      count += popcount32(w === first ? bits & (-1 << ((i + 1) & 31)) : bits);
    }
    return count;
  };

  const grow = (i: number) => {
    const cluster = [sorted[i]];
    const nodes = new Set([sorted[i].node]);
    // Triggers compatible with every member so far.
    const fits = compat.slice(i * words, (i + 1) * words);
    for (let j = i + 1; j < n && sorted[j].t - sorted[i].t <= maxSpan; j++) {
      const c = sorted[j];
      if (!(fits[j >>> 5] & (1 << (j & 31))) || used.has(c.id) || nodes.has(c.node)) continue;
      cluster.push(c);
      nodes.add(c.node);
      for (let w = j >>> 5; w < words; w++) fits[w] &= compat[j * words + w];
    }
    return cluster;
  };

  const solve = (members: Trigger[]) => {
    const ref = members[0].t;
    const sol = locateCached(members, minNodes);
    return sol && { sol, time: ref + sol.t0 * 1000, members: sol.used.map((k) => members[k]) };
  };

  type Fit = NonNullable<ReturnType<typeof solve>>;
  const good = (f: Fit | null): f is Fit => f !== null && f.sol.rms <= maxRms;
  /** The largest cluster grown from any trigger not yet used, not a dead seed, and not skipped. */
  const largest = (skip: (t: Trigger) => boolean) => {
    let out: Trigger[] = [];
    sorted.forEach((t, i) => {
      if (used.has(t.id) || deadSeeds.has(t.id) || skip(t) || maxClusterSize(i) <= out.length) return;
      const c = grow(i);
      if (c.length > out.length) out = c;
    });
    return out;
  };

  for (;;) {
    // A seed holds one wave, as compatibility is only defined within a wave.
    const seed = largest(() => false);
    if (seed.length < minNodes - 1) break;
    let fit = seed.length >= minNodes ? solve(seed) : null;
    if (seed.length >= minNodes && !good(fit)) {
      deadSeeds.add(seed[0].id);
      continue;
    }
    const base = fit ? fit.members : seed;
    // Two arrivals of the other wave that agree with each other are enough to pin the distance.
    // They can only be as far from this wave's arrivals as the S−P gap at the largest distance.
    const phase = seed[0].phase ?? 'P';
    const ts = base.map((m) => m.t);
    const gap = (MAX_DISTANCE_KM * (1 / VS_KMS - 1 / VP_KMS) + TOLERANCE_S) * 1000;
    const from = Math.min(...ts) - gap;
    const to = Math.max(...ts) + gap;
    const partner = largest((t) => (t.phase ?? 'P') === phase || t.t < from || t.t > to);
    if (partner.length >= 2) {
      const joint = solve([...base, ...partner].sort(byOnsetThenId));
      if (good(joint) && joint.members.length >= 0.8 * (base.length + partner.length)) fit = joint;
    }
    if (!good(fit)) {
      deadSeeds.add(seed[0].id);
      continue;
    }
    // Re-gather every unused trigger the solution explains, so an unlucky seed cannot bias membership.
    const f0 = fit;
    const explained = (t: Trigger) => Math.abs((t.t - f0.time) / 1000 - hypocentralKm(distanceKm(f0.sol, t)) / speedOf(t.phase)) <= 2;
    const regather = new Map<string, Trigger>();
    for (const t of sorted) if (!used.has(t.id) && !regather.has(t.node) && explained(t)) regather.set(t.node, t);
    if (regather.size >= minNodes) fit = solve([...regather.values()].sort(byOnsetThenId)) ?? fit;
    if (!good(fit) || fit.members.length < minNodes) {
      deadSeeds.add(seed[0].id);
      continue;
    }
    const f = fit;
    f.members.forEach(use);
    for (const t of sorted) {
      if (used.has(t.id) || t.t < f.time) continue;
      const tt = (t.t - f.time) / 1000;
      const hyp = hypocentralKm(distanceKm(f.sol, t));
      if (Math.abs(tt - hyp / VP_KMS) < 3 || Math.abs(tt - hyp / VS_KMS) < 3) use(t);
    }
    events.push({ ...f.sol, id: `ev-${f.members[0].id.slice(0, 12)}`, time: f.time, triggers: f.members });
  }
  return events.sort((a, b) => a.time - b.time);
}

export function associate(triggers: Trigger[], opts: AssociateOptions = {}): DetectedEvent[] {
  const key = `${opts.minNodes ?? 4}|${opts.maxRmsS ?? 1.5}`;
  const last = lastAnswer.get(key);
  if (last && last.input.length === triggers.length && last.input.every((t, i) => t === triggers[i])) return [...last.events];
  const events = associateAll(triggers, opts);
  lastAnswer.set(key, { input: [...triggers], events });
  return [...events];
}

const traced = new Map<string, Uncertainty>();

/** How far off an event's epicentre and magnitude could be (see `uncertainty`). */
export function eventUncertainty(e: DetectedEvent): Uncertainty {
  const key = `${e.id}|${e.time}|${e.lat}|${e.lon}|${e.triggers.length}`;
  let u = traced.get(key);
  if (!u) {
    traced.set(key, (u = uncertainty(toArrivals(e.triggers), e)));
    if (traced.size > 200) traced.delete(traced.keys().next().value!);
  }
  return u;
}
