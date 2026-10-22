import { distanceKm, type LatLon } from '../core/geo';
import { hypocentralKm, intensityLevel, pgaFor } from '../core/physics';

export interface UsgsQuake extends LatLon {
  id: string;
  mag: number | null;
  place: string;
  /** ms since epoch */
  time: number;
  depthKm: number;
  url: string;
}

export type UsgsWindow = 'hour' | 'day';
const USGS = 'https://earthquake.usgs.gov/earthquakes';
const feedUrl = (w: UsgsWindow) => `${USGS}/feed/v1.0/summary/all_${w}.geojson`;
/** The public page of one USGS event. */
export const usgsEventUrl = (id: string) => `${USGS}/eventpage/${id}`;

interface Feature {
  id: string;
  properties: { mag: number | null; place: string | null; time: number; url: string };
  geometry: { coordinates: [number, number, number] };
}

export function parseFeed(json: unknown): UsgsQuake[] {
  const feats = (json as { features?: Feature[] })?.features;
  if (!Array.isArray(feats)) throw new Error('Unexpected USGS response');
  return feats
    .filter((f) => f?.geometry?.coordinates?.length >= 2 && Number.isFinite(f.properties?.time))
    .map((f) => ({
      id: f.id,
      mag: f.properties.mag,
      place: f.properties.place ?? 'Unknown location',
      time: f.properties.time,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      depthKm: f.geometry.coordinates[2] ?? 0,
      url: f.properties.url,
    }))
    .sort((a, b) => b.time - a.time);
}

export async function fetchUsgs(w: UsgsWindow, fetchImpl: typeof fetch = fetch): Promise<UsgsQuake[]> {
  const res = await fetchImpl(feedUrl(w), { cache: 'no-store' });
  if (!res.ok) throw new Error(`USGS feed returned ${res.status}`);
  return parseFeed(await res.json());
}

export interface UsgsMatch {
  quake: UsgsQuake;
  distanceKm: number;
  dtS: number;
}

/** The official event that best explains one of ours: within 250 km and 2 minutes. */
export function matchUsgs(ev: LatLon & { time: number }, quakes: UsgsQuake[]): UsgsMatch | null {
  let best: UsgsMatch | null = null;
  for (const q of quakes) {
    const d = distanceKm(ev, q);
    const dt = (ev.time - q.time) / 1000;
    if (d > 250 || Math.abs(dt) > 120) continue;
    const score = d / 50 + Math.abs(dt) / 10;
    if (!best || score < best.distanceKm / 50 + Math.abs(best.dtS) / 10) best = { quake: q, distanceKm: d, dtS: dt };
  }
  return best;
}

/**
 * The listed quake someone most likely felt: one that began in the hour before their report (or up
 * to two minutes after it, as clocks differ) and that the shaking model says shook them at least
 * weakly where they are; of several, the one that shook them hardest, then the latest. Not
 * `matchUsgs`: a report is dated when its sender tapped, minutes after the quake by the time USGS lists it.
 */
export function matchFelt(report: LatLon & { t: number }, quakes: UsgsQuake[]): UsgsMatch | null {
  let best: (UsgsMatch & { level: number }) | null = null;
  for (const q of quakes) {
    const dt = (report.t - q.time) / 1000;
    if (q.mag === null || dt < -120 || dt > 3600) continue;
    const d = distanceKm(report, q);
    const level = intensityLevel(pgaFor(q.mag, hypocentralKm(d, q.depthKm)));
    if (level >= 1 && (!best || level > best.level || (level === best.level && q.time > best.quake.time))) best = { quake: q, distanceKm: d, dtS: dt, level };
  }
  return best;
}
