import { distanceKm, type LatLon } from './geo';
import { locate, type Solution } from './locate';
import { VP_KMS, VS_KMS, hypocentralKm } from './physics';

export interface Trigger extends LatLon {
  id: string;
  node: string;
  /** Onset time, ms since epoch. */
  t: number;
  /** Peak acceleration, m/s². */
  pga: number;
}

export interface DetectedEvent extends Solution {
  id: string;
  /** Origin time, ms since epoch. */
  time: number;
  triggers: Trigger[];
}

export interface AssociateOptions {
  minNodes?: number;
  /** Allowed slack beyond the P travel-time bound, seconds (phone clocks drift). */
  toleranceS?: number;
  maxDistanceKm?: number;
  maxSpanS?: number;
  maxRmsS?: number;
}

/**
 * Space–time association. Two triggers can belong to one earthquake only if their time
 * difference is no larger than the P-wave travel time between the nodes (plus slack).
 *  1. From every unused trigger, grow a cluster of pairwise-compatible triggers (one per node).
 *  2. Locate the largest cluster by grid search, dropping bad clocks.
 *  3. Re-gather every unused trigger the solution explains as a P arrival, and relocate,
 *     so an unlucky seed (e.g. a stray footstep) cannot bias membership.
 *  4. Triggers the event explains as S arrivals are absorbed so they do not spawn ghosts.
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

  const compatible = (a: Trigger, b: Trigger) => {
    const d = distanceKm(a, b);
    return d <= maxD && Math.abs(a.t - b.t) / 1000 <= d / VP_KMS + tol;
  };

  const grow = (i: number) => {
    const cluster = [sorted[i]];
    const nodes = new Set([sorted[i].node]);
    for (let j = i + 1; j < sorted.length && sorted[j].t - sorted[i].t <= maxSpan; j++) {
      const c = sorted[j];
      if (used.has(c.id) || nodes.has(c.node)) continue;
      if (cluster.every((m) => compatible(m, c))) {
        cluster.push(c);
        nodes.add(c.node);
      }
    }
    return cluster;
  };

  const solve = (members: Trigger[]) => {
    const ref = members[0].t;
    const sol = locate(
      members.map((c) => ({ lat: c.lat, lon: c.lon, t: (c.t - ref) / 1000, pga: c.pga })),
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
    if (fit && fit.sol.rms <= maxRms) {
      const f = fit;
      const explained = (t: Trigger, v: number, slack: number) =>
        Math.abs((t.t - f.time) / 1000 - hypocentralKm(distanceKm(f.sol, t)) / v) <= slack;
      const regather = new Map<string, Trigger>();
      for (const t of sorted) if (!used.has(t.id) && !regather.has(t.node) && explained(t, VP_KMS, 2)) regather.set(t.node, t);
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
