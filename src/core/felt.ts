import { cellOf, distanceKm, type LatLon } from './geo';
import { upperMedian } from './stats';

/** Someone felt shaking here at t, this strong: 1 weak … 5 very strong (see `intensityLevel`). */
export interface Felt extends LatLon {
  id: string;
  node: string;
  t: number;
  lvl: number;
}

/** One shaking, as several people reported it. */
export interface FeltCluster extends LatLon {
  reports: Felt[];
  /** Distinct keys, and distinct 0.01° cells, among the reports. */
  people: number;
  places: number;
  /** When it was first felt. */
  time: number;
  /** The level most people reported (upper median). */
  lvl: number;
}

const CLUSTER_KM = 30;
const CLUSTER_MS = 10 * 60_000;
/** A key's reports count once per ten minutes: the first of them. */
export const FELT_EVERY_MS = 10 * 60_000;
const CLUSTER_DEG = CLUSTER_KM / 111;
/** Keys are free and places are typed in, so a shaking counts only once this many of each agree. */
const MIN_KEYS = 3;
const MIN_CELLS = 3;

/**
 * Felt reports grouped into shakings. Each key counts once per ten minutes. A report joins the
 * earliest shaking that began within 30 km and 10 minutes of it, so no chain of reports can
 * stretch a shaking across a region. Reports are taken in time order, ties by id, so every
 * browser groups the same reports the same way whatever order they arrived in. Only groups from
 * three keys in three cells are returned, oldest first.
 */
export function clusterFelt(reports: Felt[]): FeltCluster[] {
  const groups: Felt[][] = [];
  const counted = new Map<string, number>();
  let open = 0;
  for (const r of [...reports].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const last = counted.get(r.node);
    if (last !== undefined && r.t - last < FELT_EVERY_MS) continue;
    counted.set(r.node, r.t);
    while (open < groups.length && r.t - groups[open][0].t > CLUSTER_MS) open++;
    let g: Felt[] | undefined;
    for (let i = open; i < groups.length && !g; i++) {
      const first = groups[i][0];
      if (Math.abs(first.lat - r.lat) <= CLUSTER_DEG && distanceKm(first, r) <= CLUSTER_KM) g = groups[i];
    }
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups.flatMap((g) => {
    const people = new Set(g.map((r) => r.node)).size;
    const places = new Set(g.map(cellOf)).size;
    if (people < MIN_KEYS || places < MIN_CELLS) return [];
    const mid = (xs: number[]) => upperMedian(xs)!;
    return [{ reports: g, people, places, time: g[0].t, lvl: mid(g.map((r) => r.lvl)), lat: mid(g.map((r) => r.lat)), lon: mid(g.map((r) => r.lon)) }];
  });
}
