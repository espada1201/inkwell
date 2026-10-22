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

/** Reports this close in space and time can be one shaking. */
const CLUSTER_KM = 30;
const CLUSTER_MS = 10 * 60_000;
/** Keys are free and places are typed in, so a shaking counts only once this many of each agree. */
const MIN_KEYS = 3;
const MIN_CELLS = 3;

/**
 * Felt reports grouped into shakings. A report joins the earliest group whose every report is
 * within 30 km and 10 minutes of it, so no chain of reports can stretch a shaking across a
 * region. Only groups from three keys in three cells are returned, oldest first.
 */
// shortcut: each report is compared with every member of the open groups, n² under a flood; index groups by cell if floods are seen.
export function clusterFelt(reports: Felt[]): FeltCluster[] {
  const groups: Felt[][] = [];
  for (const r of [...reports].sort((a, b) => a.t - b.t)) {
    const g = groups.find((g) => g.every((x) => r.t - x.t <= CLUSTER_MS && distanceKm(x, r) <= CLUSTER_KM));
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
