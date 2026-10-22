import { coarsen, distanceKm, offset, type LatLon } from './geo';
import { VP_KMS, VS_KMS, hypocentralKm, pgaFor } from './physics';
import { gauss, rng } from './rng';
import { NodeDetector, type DetectorOutput, type Sample } from './sensor';
import { synthesize } from './synth';

export interface Scenario {
  id: string;
  title: string;
  place: string;
  blurb: string;
  /** Reference hypocentre (from the USGS catalogue for real events). null = no quake. */
  truth: (LatLon & { depthKm: number; mag: number; usgsId?: string; date?: string }) | null;
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

export interface SimNode extends LatLon {
  id: string;
  distKm: number | null;
  pga: number;
  samples: Sample[];
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
/** Samples per second of every simulated phone record. */
export const FS = 50;

/** Build a phone network around the city and synthesise every phone's accelerometer record. */
export function simulate(s: Scenario, start: number): Simulation {
  const r = rng(s.seed);
  const durationS = 80;
  const nodes: SimNode[] = [];
  const kinds = ['footsteps', 'slam', 'pickup'] as const;
  for (let i = 0; i < s.nodes; i++) {
    const ang = r() * 2 * Math.PI;
    const rad = s.radiusKm * Math.sqrt(r());
    const loc = coarsen(offset(s.city, rad * Math.cos(ang), rad * Math.sin(ang)));
    const distKm = s.truth ? distanceKm(s.truth, loc) : null;
    const hyp = distKm === null ? null : hypocentralKm(distKm, s.truth!.depthKm);
    const tP = hyp === null ? null : ORIGIN_OFFSET_S + hyp / VP_KMS;
    const tS = hyp === null ? null : ORIGIN_OFFSET_S + hyp / VS_KMS;
    const pga = hyp === null ? 0 : pgaFor(s.truth!.mag, hyp) * 10 ** (0.15 * gauss(r));
    const disturbance = r() < s.disturbed ? kinds[Math.floor(r() * 3)] : null;
    const dT = 8 + r() * (durationS - 30);
    const clockErr = 0.15 * gauss(r);
    const samples = synthesize({
      fs: FS,
      start: start + clockErr * 1000,
      durationS,
      seed: s.seed * 1000 + i,
      noise: 0.008 + 0.01 * r(),
      quake: tP !== null && tS !== null ? { tP, tS, pga, decayS: 2 + s.truth!.mag - 4 } : undefined,
      footsteps: disturbance === 'footsteps' ? { t: dT, count: 6 + Math.floor(r() * 8) } : undefined,
      slam: disturbance === 'slam' ? { t: dT } : undefined,
      pickup: disturbance === 'pickup' ? { t: dT } : undefined,
    });
    const det = new NodeDetector(FS);
    const outputs: DetectorOutput[] = [];
    for (const smp of samples) {
      const o = det.push(smp);
      if (o) outputs.push(o);
    }
    nodes.push({ id: `${s.id}-${i}`, ...loc, distKm, pga, samples, outputs });
  }
  return { scenario: s, start, origin: start + ORIGIN_OFFSET_S * 1000, durationS, nodes };
}
