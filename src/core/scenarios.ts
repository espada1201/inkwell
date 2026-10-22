import { coarsen, distanceKm, type LatLon } from './geo';
import { VP_KMS, VS_KMS, hypocentralKm, pgaFor } from './physics';
import { gauss, rng } from './rng';
import { NodeDetector, type DetectorOutput } from './sensor';
import { CLOCK_SIGMA_MS, FS, RELAY_LATENCY_MS, codaS, phoneNoise, pointInDisk, siteScatter } from './simnet';
import { synthesize } from './synth';

export interface Scenario {
  id: string;
  title: string;
  place: string;
  blurb: string;
  /** The quake as the USGS catalogue has it, with its event id and origin time (ISO). null = no quake. */
  truth: (LatLon & { depthKm: number; mag: number; usgsId: string; date: string }) | null;
  /** Where the simulated phones live. */
  city: LatLon;
  radiusKm: number;
  nodes: number;
  /** Fraction of phones that also suffer a door slam, footsteps, or being picked up. */
  disturbed: number;
  seed: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'napa-2014',
    title: 'South Napa M6.0',
    place: 'San Francisco Bay Area',
    blurb: '24 Aug 2014, 03:20 local. Most of the Bay Area was asleep with phones on nightstands.',
    truth: { lat: 38.215, lon: -122.312, depthKm: 11, mag: 6.0, usgsId: 'nc72282711', date: '2014-08-24T10:20:44Z' },
    city: { lat: 37.95, lon: -122.25 },
    radiusKm: 55,
    nodes: 48,
    disturbed: 0.15,
    seed: 2014,
  },
  {
    id: 'ridgecrest-2019',
    title: 'Ridgecrest M7.1',
    place: 'Mojave Desert, California',
    blurb: '5 Jul 2019, evening. A sparse desert network: few phones, long distances, strong shaking.',
    truth: { lat: 35.77, lon: -117.599, depthKm: 8, mag: 7.1, usgsId: 'ci38457511', date: '2019-07-06T03:19:53Z' },
    city: { lat: 35.55, lon: -117.75 },
    radiusKm: 110,
    nodes: 28,
    disturbed: 0.1,
    seed: 2019,
  },
  {
    id: 'christchurch-2011',
    title: 'Christchurch M6.1',
    place: 'Canterbury, New Zealand',
    blurb: '22 Feb 2011, lunchtime. A shallow quake almost directly beneath the city.',
    truth: { lat: -43.583, lon: 172.68, depthKm: 5, mag: 6.1, usgsId: 'usp000hvnu', date: '2011-02-21T23:51:42Z' },
    city: { lat: -43.53, lon: 172.62 },
    radiusKm: 22,
    nodes: 40,
    disturbed: 0.2,
    seed: 2011,
  },
  {
    id: 'stadium-night',
    title: 'Concert night, no quake',
    place: 'Downtown Los Angeles',
    blurb: 'Footsteps, slammed doors and phones grabbed off tables all evening. The network should stay quiet.',
    truth: null,
    city: { lat: 34.05, lon: -118.25 },
    radiusKm: 15,
    nodes: 40,
    disturbed: 0.9,
    seed: 77,
  },
];

/** What a replay needs to know of a quake, so a link to it still works once it has left the USGS feed. */
export interface QuakeRef extends LatLon {
  /** USGS event id. */
  id: string;
  /** Origin time, ms since epoch. */
  time: number;
  depthKm: number;
  mag: number;
}

/** Weaker quakes are not offered for replay: phones barely feel them. */
export const MIN_REPLAY_MAG = 4;

/** The path after #replay/ that names a quake. */
export const quakeLink = (q: QuakeRef) => ['usgs', q.id, q.time, q.lat, q.lon, q.depthKm, q.mag].join('/');

/** The quake a path from `quakeLink` names; null if it is not one, or a number is missing or out of range. */
export function parseQuakeLink(path: string): QuakeRef | null {
  const [kind, id = '', ...fields] = path.split('/');
  const [time, lat, lon, depthKm, mag] = fields.map((f) => (f === '' ? NaN : Number(f)));
  const ok =
    kind === 'usgs' && /^[\w-]+$/.test(id) && fields.length === 5 && [time, lat, lon, depthKm, mag].every(Number.isFinite) &&
    !isNaN(new Date(time).getTime()) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && depthKm >= -10 && depthKm <= 800 && mag >= MIN_REPLAY_MAG && mag <= 10;
  return ok ? { id, time, lat, lon, depthKm, mag } : null;
}

export interface SimNode extends LatLon {
  id: string;
  distKm: number | null;
  pga: number;
  /** What the detector heard: bandpassed shaking magnitude per sample, m/s², silent while its filters settle. */
  trace: Float32Array;
  outputs: DetectorOutput[];
}

export interface Simulation {
  scenario: Scenario;
  /** ms epoch of scenario start; origin time is start + ORIGIN_OFFSET_S. */
  start: number;
  origin: number;
  durationS: number;
  nodes: SimNode[];
}

export const ORIGIN_OFFSET_S = 25;
/** Scenario ms (since the scenario started) → seconds since the quake's origin. */
export const sinceOrigin = (scenarioMs: number) => scenarioMs / 1000 - ORIGIN_OFFSET_S;

const MIN_DURATION_S = 80;
const CHECK_S = 30;

/** Build a phone network around the city and synthesise every phone's accelerometer record. */
export function simulate(s: Scenario, start: number): Simulation {
  const r = rng(s.seed);
  const kinds = ['footsteps', 'slam', 'pickup'] as const;
  const phones = Array.from({ length: s.nodes }, () => {
    const loc = coarsen(pointInDisk(s.city, s.radiusKm, r));
    const distKm = s.truth ? distanceKm(s.truth, loc) : null;
    const hyp = distKm === null ? null : hypocentralKm(distKm, s.truth!.depthKm);
    const tP = hyp === null ? null : ORIGIN_OFFSET_S + hyp / VP_KMS;
    const tS = hyp === null ? null : ORIGIN_OFFSET_S + hyp / VS_KMS;
    const pga = hyp === null ? 0 : pgaFor(s.truth!.mag, hyp) * siteScatter(r);
    const disturbance = r() < s.disturbed ? kinds[Math.floor(r() * 3)] : null;
    const dT = 8 + r() * (MIN_DURATION_S - 30);
    const clockMs = CLOCK_SIGMA_MS * gauss(r);
    const noise = phoneNoise(r);
    const steps = disturbance === 'footsteps' ? 6 + Math.floor(r() * 8) : 0;
    return { loc, distKm, tP, tS, pga, disturbance, dT, clockMs, noise, steps };
  });
  const lastS = Math.max(0, ...phones.map((p) => p.tS ?? 0));
  const durationS = Math.max(MIN_DURATION_S, Math.ceil(lastS + CHECK_S + RELAY_LATENCY_MS / 1000));
  const nodes = phones.map(({ loc, distKm, tP, tS, pga, disturbance, dT, clockMs, noise, steps }, i): SimNode => {
    const samples = synthesize({
      fs: FS,
      start: start + clockMs,
      durationS,
      seed: s.seed * 1000 + i,
      noise,
      quake: tP !== null && tS !== null ? { tP, tS, pga, decayS: codaS(s.truth!.mag) } : undefined,
      footsteps: disturbance === 'footsteps' ? { t: dT, count: steps } : undefined,
      slam: disturbance === 'slam' ? { t: dT } : undefined,
      pickup: disturbance === 'pickup' ? { t: dT } : undefined,
    });
    const det = new NodeDetector(FS);
    const trace = new Float32Array(samples.length);
    const outputs: DetectorOutput[] = [];
    samples.forEach((smp, k) => {
      const o = det.push(smp);
      if (o) outputs.push(o);
      if (k >= FS) trace[k] = det.level;
    });
    return { id: `${s.id}-${i}`, ...loc, distKm, pga, trace, outputs };
  });
  return { scenario: s, start, origin: start + ORIGIN_OFFSET_S * 1000, durationS, nodes };
}
