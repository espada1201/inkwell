import { distanceKm, type LatLon } from './geo';
import { locate, type Solution } from './locate';
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
}

export interface DetectedEvent extends Solution {
  id: string;
  /** Origin time, ms since epoch. */
  time: number;
  triggers: Trigger[];
}

export interface AssociateOptions {
  minNodes?: number;
  /** Allowed slack beyond the travel-time bound, seconds (phone clocks drift). */
  toleranceS?: number;
  maxDistanceKm?: number;
  maxSpanS?: number;
  maxRmsS?: number;
}

/**
 * Space–time association. Two triggers of the same wave can belong to one earthquake only if
 * their time difference is no larger than that wave's travel time between the nodes (plus slack).
 *  1. From every unused trigger, grow a cluster of pairwise-compatible triggers (one per node).
 *  2. Locate the largest cluster by grid search, dropping bad clocks.
 *  3. If it holds one wave only, try adding the largest cluster of the other wave: from outside
 *     the network a quake's distance trades off against its origin time, and the gap between
 *     its P and S arrivals is what pins it.
 *  4. Re-gather every unused trigger the solution explains as an arrival of its own wave, and
 *     relocate, so an unlucky seed (e.g. a stray footstep) cannot bias membership.
 *  5. Later triggers the event explains as either wave are absorbed so they do not spawn ghosts.
 */
export function associate(triggers: Trigger[], opts: AssociateOptions = {}): DetectedEvent[] {
  const minNodes = opts.minNodes ?? 3;
  const tol = opts.toleranceS ?? 1.5;
  const maxD = opts.maxDistanceKm ?? 400;
  const maxSpan = (opts.maxSpanS ?? 90) * 1000;
  const maxRms = opts.maxRmsS ?? 1.5;

  const sorted = [...triggers].sort((a, b) => a.t - b.t);
  const used = new Set<string>();
  const deadSeeds = new Set<string>();
  const events: DetectedEvent[] = [];

  // Pairwise compatibility as one bitset row per trigger, so growing a cluster costs a few
  // word-ANDs per member instead of a distance check against every member (a city of a
  // thousand phones would otherwise take seconds).
  const n = sorted.length;
  const words = (n + 31) >>> 5;
  const compat = new Uint32Array(n * words);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n && sorted[b].t - sorted[a].t <= maxSpan; b++) {
      const d = distanceKm(sorted[a], sorted[b]);
      const phase = sorted[a].phase ?? 'P';
      if (phase === (sorted[b].phase ?? 'P') && d <= maxD && (sorted[b].t - sorted[a].t) / 1000 <= d / speedOf(phase) + tol) {
        compat[a * words + (b >>> 5)] |= 1 << (b & 31);
        compat[b * words + (a >>> 5)] |= 1 << (a & 31);
      }
    }
  }

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
      for (let w = 0; w < words; w++) fits[w] &= compat[j * words + w];
    }
    return cluster;
  };

  const solve = (members: Trigger[]) => {
    const ref = members[0].t;
    const sol = locate(
      members.map((c) => ({ lat: c.lat, lon: c.lon, t: (c.t - ref) / 1000, pga: c.pga, phase: c.phase })),
      { minArrivals: minNodes, maxOutliers: Math.floor(members.length * 0.3) },
    );
    return sol && { sol, time: ref + sol.t0 * 1000, members: sol.used.map((k) => members[k]) };
  };

  for (;;) {
    let best: Trigger[] = [];
    sorted.forEach((t, i) => {
      if (used.has(t.id) || deadSeeds.has(t.id)) return;
      const c = grow(i);
      if (c.length > best.length) best = c;
    });
    if (best.length < minNodes) break;

    let fit = solve(best);
    // Clusters hold one wave, as compatibility is only defined within a wave.
    const phase = best[0].phase ?? 'P';
    if (fit && fit.sol.rms <= maxRms) {
      let partner: Trigger[] = [];
      sorted.forEach((t, i) => {
        if (used.has(t.id) || deadSeeds.has(t.id) || (t.phase ?? 'P') === phase) return;
        const c = grow(i);
        if (c.length > partner.length) partner = c;
      });
      if (partner.length >= minNodes) {
        const joint = solve([...fit.members, ...partner].sort((a, b) => a.t - b.t));
        if (joint && joint.sol.rms <= maxRms && joint.members.length >= 0.8 * (fit.members.length + partner.length)) fit = joint;
      }
    }
    if (fit && fit.sol.rms <= maxRms) {
      const f = fit;
      const explained = (t: Trigger) => Math.abs((t.t - f.time) / 1000 - hypocentralKm(distanceKm(f.sol, t)) / speedOf(t.phase)) <= 2;
      const regather = new Map<string, Trigger>();
      for (const t of sorted) if (!used.has(t.id) && !regather.has(t.node) && explained(t)) regather.set(t.node, t);
      if (regather.size >= minNodes) fit = solve([...regather.values()].sort((a, b) => a.t - b.t)) ?? fit;
    }
    if (!fit || fit.sol.rms > maxRms) {
      deadSeeds.add(best[0].id);
      continue;
    }
    const f = fit;
    f.members.forEach((m) => used.add(m.id));
    for (const t of sorted) {
      if (used.has(t.id) || t.t < f.time) continue;
      const tt = (t.t - f.time) / 1000;
      const hyp = hypocentralKm(distanceKm(f.sol, t));
      if (Math.abs(tt - hyp / VP_KMS) < 3 || Math.abs(tt - hyp / VS_KMS) < 3) used.add(t.id);
    }
    events.push({ ...f.sol, id: `ev-${f.members[0].id.slice(0, 12)}`, time: f.time, triggers: f.members });
  }
  return events.sort((a, b) => a.time - b.time);
}
