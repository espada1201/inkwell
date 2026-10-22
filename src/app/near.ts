import { distanceKm, type LatLon } from '../core/geo';
import { hypocentralKm, intensityLevel, pgaFor } from '../core/physics';
import type { LiveNetwork } from './live';
import type { SensorNode } from './sensor';

/** This browser's rough location, which the sensor screen sets too, and whether this phone shares it as a sensor. */
export type Place = Pick<SensorNode, 'location' | 'setLocation' | 'canPublish'>;

/** Tremor detections this close to you in the last ten minutes are near you, as are felt reports this close and USGS quakes this close in their feed. */
const NEAR_KM = 100;
export const NEAR_MS = 10 * 60_000;
const NEAR_USGS_KM = 300;
/** Quakes below about M2.5 are usually not felt, yet the shaking model, made for bigger ones, puts small ones close by at light or more. */
const FELT_MAG = 2.5;
/** Light shaking, which people indoors notice. Below it a row is listed, with nothing to do about it. */
export const NOTICED_LEVEL = 2;

/** Something reported near you, and how hard it shook you: roughly, for quakes (a level, as `intensityLevel` counts); as people told it, for felt reports. */
export type Near = { km: number; time: number; level: number | null } & (
  | { kind: 'provisional' | 'confirmed'; mag: number | null }
  | { kind: 'usgs'; mag: number | null; place: string }
  | { kind: 'felt'; people: number; places: number }
);

/** What has been reported near you that could have shaken you, nearest first. */
export function nearYou(live: LiveNetwork, you: LatLon, now = Date.now()): Near[] {
  const shook = (e: LatLon & { mag: number | null }, km: number, depthKm?: number) => {
    if (e.mag === null) return null;
    const level = intensityLevel(pgaFor(e.mag, hypocentralKm(km, depthKm)));
    return e.mag < FELT_MAG ? Math.min(level, 1) : level;
  };
  const ours: Near[] = [
    ...live.early.map((e) => ({ kind: 'provisional' as const, e })),
    ...live.events.filter((e) => now - e.time < NEAR_MS).map((e) => ({ kind: 'confirmed' as const, e })),
  ].map(({ kind, e }) => {
    const km = distanceKm(you, e);
    return { kind, km, time: e.time, mag: e.mag, level: shook(e, km) };
  });
  const felt: Near[] = live.feltClusters.map((c) => ({ kind: 'felt', km: distanceKm(you, c), time: c.time, level: c.lvl, people: c.people, places: c.places }));
  const usgs: Near[] = live.usgs.map((q) => {
    const km = distanceKm(you, q);
    return { kind: 'usgs', km, time: q.time, mag: q.mag, place: q.place, level: shook(q, km, q.depthKm) };
  });
  // USGS lists every quake it locates, most of them too weak to feel this far away.
  return [...[...ours, ...felt].filter((x) => x.km <= NEAR_KM), ...usgs.filter((x) => x.km <= NEAR_USGS_KM && x.level !== 0)].sort((a, b) => a.km - b.km);
}

/**
 * Worth an alert: shaking people here would notice, found by phones' confirmed reports or by USGS.
 * What people say they felt is listed but never alerts by itself, since anyone can make keys that
 * say anything; a provisional detection's phones may still withdraw.
 */
export const alerts = (x: Near) => (x.kind === 'confirmed' || x.kind === 'usgs') && x.level !== null && x.level >= NOTICED_LEVEL;
