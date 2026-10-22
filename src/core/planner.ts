import { associate, type Trigger } from './associate';
import { earlyDetect } from './early';
import { coarsen, distanceKm, offset, type LatLon } from './geo';
import { VP_KMS, VS_KMS, hypocentralKm, intensityLevel, pgaFor, type Phase } from './physics';
import { gauss, rng } from './rng';
import { NodeDetector, type DetectorOutput } from './sensor';
import { synthesize } from './synth';

/**
 * Network planner: how many phones does a city need?
 *
 * Hundreds of quakes against thousands of phones is too much to synthesise sample by sample,
 * so each phone is replaced by its measured behaviour. `calibrate` runs the real on-device
 * detector over synthetic records across shaking levels and S−P times; every simulated phone
 * then draws its outcome (noticed or not, how late, confirmed or retracted) from those runs.
 * Everything downstream is the real network code: early detection from picks, association,
 * location and warning time.
 */

const FS = 50;
const PGA_LEVELS = [0.005, 0.01, 0.02, 0.035, 0.06, 0.1, 0.18, 0.3, 0.55, 1, 1.8, 3.2];
const SP_LEVELS = [1, 2.5, 5, 9];
const RUNS = 6;
const LATENCY_MS = 1000;
/** Browsers batch incoming relay messages; the network is re-evaluated at most this often. */
const FRAME_MS = 250;
/** Phones bumped, walked past or picked up in any given minute: an assumption, not a measurement. */
export const DISTURBED_PER_MINUTE = 0.05;
/** Above this many confirmed triggers, locate from an even sample of them (the app uses all). */
const MAX_CONFIRM = 300;

interface Response {
  /** Seconds from the P arrival to the onset the phone picked; null when it never noticed. */
  delay: number | null;
  /** The wave the phone said it felt. */
  phase: Phase;
  /** Seconds from the onset until the pick went out. */
  sent: number;
  /** Seconds from the onset to the phone's verdict. */
  vet: number;
  confirmed: boolean;
  /** Measured peak over true peak acceleration. */
  gain: number;
}

export interface PhoneModel {
  /** [shaking level][S−P time][run] */
  cells: Response[][][];
}

/** Measure the real phone detector on synthetic quakes of this magnitude (about a second of work). */
export function calibrate(mag: number): PhoneModel {
  const r = rng(Math.round(mag * 1000));
  const tP = 12;
  const cells = PGA_LEVELS.map((pga) =>
    SP_LEVELS.map((sp) =>
      Array.from({ length: RUNS }, (): Response => {
        const det = new NodeDetector(FS);
        const record = synthesize({
          fs: FS,
          start: 0,
          durationS: tP + sp + 32,
          seed: Math.floor(r() * 2 ** 31),
          noise: 0.008 + 0.01 * r(),
          quake: { tP, tS: tP + sp, pga, decayS: 2 + mag - 4 },
        });
        let pick: Extract<DetectorOutput, { kind: 'pick' }> | null = null;
        for (const s of record) {
          const o = det.push(s);
          if (!o) continue;
          if (o.kind === 'pick') {
            if (pick === null && o.t >= (tP - 1) * 1000) pick = o;
          } else if (pick && o.t === pick.t) {
            const sent = (pick.at - pick.t) / 1000;
            return { delay: pick.t / 1000 - tP, phase: pick.phase, sent, vet: (o.at - pick.t) / 1000, confirmed: o.kind === 'trigger', gain: o.kind === 'trigger' ? o.pga / pga : 1 };
          }
        }
        return { delay: null, phase: 'P', sent: 0, vet: 0, confirmed: false, gain: 1 };
      }),
    ),
  );
  return { cells };
}

/** Draw one phone's behaviour for a given true shaking level and S−P time. */
function respond(m: PhoneModel, pga: number, sp: number, r: () => number): Response {
  const lp = Math.log(pga);
  let i = 0;
  while (i < PGA_LEVELS.length - 1 && Math.log(PGA_LEVELS[i + 1]) <= lp) i++;
  // Between two measured levels: choose one at random, weighted by closeness in log PGA.
  if (i < PGA_LEVELS.length - 1 && lp > Math.log(PGA_LEVELS[i])) {
    const f = (lp - Math.log(PGA_LEVELS[i])) / (Math.log(PGA_LEVELS[i + 1]) - Math.log(PGA_LEVELS[i]));
    if (r() < f) i++;
  }
  let j = 0;
  SP_LEVELS.forEach((v, k) => Math.abs(v - sp) < Math.abs(SP_LEVELS[j] - sp) && (j = k));
  const runs = m.cells[i][j];
  const out = runs[Math.floor(r() * runs.length)];
  // A pick made on the S wave moves with this phone's own S−P time.
  return out.delay !== null && out.phase === 'S' ? { ...out, delay: out.delay - SP_LEVELS[j] + sp } : out;
}

export interface PlanInput {
  city: LatLon;
  /** Radius of the area where the phones, and the people, are. */
  radiusKm: number;
  /** Phones listening at the moment the quake strikes. */
  phones: number;
  mag: number;
  /** Range of epicentral distances from the city centre, km. */
  distanceKm: [number, number];
  depthKm?: number;
  quakes?: number;
  seed?: number;
  /** Also locate from vetted triggers (slower; the sweep skips it). */
  confirm?: boolean;
}

export interface Trial {
  epicentre: LatLon;
  /** Seconds after the rupture that a watching browser declared the quake; null = missed. */
  declaredS: number | null;
  /** Distance from the epicentre the vetted triggers point to, km; null = not located. */
  errKm: number | null;
  /** Per resident who felt at least moderate shaking: seconds of warning (≤ 0: none in time). */
  warnings: number[];
}

export interface Summary {
  phones: number;
  /** Share of quakes declared. */
  detected: number;
  medianDeclaredS: number | null;
  medianErrKm: number | null;
  /** Share of moderately-or-worse shaken residents alerted before the S wave. */
  warned: number | null;
  medianWarningS: number | null;
  falseAlerts: number;
  quietMinutes: number;
}

export interface PlanResult {
  summary: Summary;
  trials: Trial[];
  /** Phone positions of the last quake, for the map. */
  phones: LatLon[];
}

interface Arrival {
  at: number;
  kind: 'pick' | 'retract';
  tr: Trigger;
}
type Node = LatLon & { id: string };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

function scatter(c: LatLon, radiusKm: number, n: number, r: () => number): LatLon[] {
  return Array.from({ length: n }, () => {
    const a = r() * 2 * Math.PI;
    const d = radiusKm * Math.sqrt(r());
    return offset(c, d * Math.cos(a), d * Math.sin(a));
  });
}

/** Evenly spaced points standing in for where people live. */
export function residents(c: LatLon, radiusKm: number, target = 150): LatLon[] {
  const step = Math.sqrt((Math.PI * radiusKm * radiusKm) / target);
  const out: LatLon[] = [];
  for (let e = -radiusKm; e <= radiusKm; e += step) for (let n = -radiusKm; n <= radiusKm; n += step) if (Math.hypot(e, n) <= radiusKm) out.push(offset(c, e, n));
  return out;
}

/** A bump at a random time in [fromS, toS]: a pick, then a retraction once the phone has vetted it. */
function bump(node: Node, r: () => number, fromS: number, toS: number): [Arrival, Arrival] {
  const t = (fromS + (toS - fromS) * r()) * 1000;
  const tr: Trigger = { id: `${node.id}:b`, node: node.id, lat: node.lat, lon: node.lon, t, pga: 0 };
  return [
    { at: t + LATENCY_MS, kind: 'pick', tr },
    { at: t + 15_000 + LATENCY_MS, kind: 'retract', tr },
  ];
}

/** Watch arrivals the way a browser does and return the first declaration at or after `from`. */
function firstDeclaration(arrivals: Arrival[], nodes: Node[], from = -Infinity) {
  arrivals.sort((a, b) => a.at - b.at);
  const picks = new Map<string, Trigger>();
  let frame: number | null = null;
  let fresh = false;
  for (let i = 0; i < arrivals.length; i++) {
    const a = arrivals[i];
    if (a.kind === 'pick') {
      picks.set(a.tr.id, a.tr);
      fresh = true;
    } else picks.delete(a.tr.id);
    frame ??= a.at;
    const next = arrivals[i + 1];
    if (next && next.at - frame < FRAME_MS) continue;
    frame = null;
    // Skip frames that only withdrew picks: they hold less evidence than the frame before.
    if (!fresh || picks.size < 4 || a.at < from) continue;
    fresh = false;
    const ev = earlyDetect([...picks.values()], nodes, a.at)[0];
    if (ev) return { at: a.at, ev };
  }
  return null;
}

function quake(input: PlanInput, model: PhoneModel, people: LatLon[], r: () => number) {
  const depth = input.depthKm ?? 10;
  const [near, far] = input.distanceKm;
  const ang = r() * 2 * Math.PI;
  const d = Math.sqrt(near * near + (far * far - near * near) * r());
  const epi = offset(input.city, d * Math.cos(ang), d * Math.sin(ang));
  const phones = scatter(input.city, input.radiusKm, input.phones, r);
  const nodes: Node[] = phones.map((p, i) => ({ id: `p${i}`, ...coarsen(p) }));
  const arrivals: Arrival[] = [];
  const triggers: Trigger[] = [];

  phones.forEach((p, i) => {
    const node = nodes[i];
    const clock = 150 * gauss(r);
    const hyp = hypocentralKm(distanceKm(epi, p), depth);
    const tP = hyp / VP_KMS;
    const pga = pgaFor(input.mag, hyp) * 10 ** (0.15 * gauss(r));
    const o = respond(model, pga, hyp / VS_KMS - tP, r);
    let t = o.delay === null ? null : (tP + o.delay) * 1000 + clock;
    // Only bumps that can overlap the quake matter here; quiet minutes measure the rest.
    if (r() < (DISTURBED_PER_MINUTE * 45) / 60) {
      const [pick, retract] = bump(node, r, -15, 30);
      const bt = pick.tr.t;
      // A bump during the quake's own vetting is absorbed; a quake during a bump's vetting is missed.
      if (t === null || bt < t || bt > t + o.vet * 1000) {
        arrivals.push(pick, retract);
        if (t !== null && t >= bt && t <= bt + 15_000) t = null;
      }
    }
    if (t === null) return;
    const tr: Trigger = { id: `${node.id}:q`, node: node.id, lat: node.lat, lon: node.lon, t, pga: pga * o.gain, phase: o.phase };
    arrivals.push({ at: t + o.sent * 1000 + LATENCY_MS, kind: 'pick', tr });
    if (o.confirmed) triggers.push(tr);
    else arrivals.push({ at: t + o.vet * 1000 + LATENCY_MS, kind: 'retract', tr });
  });

  // False alerts are counted in quiet minutes, so only look once the P wave has reached someone.
  const firstPick = Math.min(...arrivals.filter((a) => a.tr.id.endsWith(':q')).map((a) => a.at));
  const dec = firstDeclaration(arrivals, nodes, firstPick);
  const declaredS = dec && dec.at / 1000;
  // The alert then travels back out through the relays to every phone.
  const alertAt = declaredS === null ? Infinity : declaredS + LATENCY_MS / 1000;
  const warnings: number[] = [];
  for (const q of people) {
    const hyp = hypocentralKm(distanceKm(epi, q), depth);
    if (intensityLevel(pgaFor(input.mag, hyp)) >= 3) warnings.push(hyp / VS_KMS - alertAt);
  }
  let errKm: number | null = null;
  if (input.confirm && triggers.length >= 3) {
    const sample = triggers.length > MAX_CONFIRM ? triggers.filter((_, i) => i % Math.ceil(triggers.length / MAX_CONFIRM) === 0) : triggers;
    const ev = associate(sample).sort((a, b) => b.triggers.length - a.triggers.length)[0];
    if (ev) errKm = distanceKm(ev, epi);
  }
  const trial: Trial = { epicentre: epi, declaredS, errKm, warnings };
  return { trial, phones };
}

/** A minute with no earthquake: does anyone's bump turn into a false alert? */
function quietMinute(input: PlanInput, r: () => number) {
  const nodes: Node[] = scatter(input.city, input.radiusKm, input.phones, r).map((p, i) => ({ id: `p${i}`, ...coarsen(p) }));
  const arrivals = nodes.flatMap((n) => (r() < DISTURBED_PER_MINUTE ? bump(n, r, 0, 60) : []));
  return firstDeclaration(arrivals, nodes) !== null;
}

/** The planner as a sequence of steps (one simulated quake or quiet minute each), yielding progress 0..1. */
export function* simulatePlan(input: PlanInput, model: PhoneModel): Generator<number, PlanResult> {
  const r = rng(input.seed ?? 1);
  const people = residents(input.city, input.radiusKm);
  const n = input.quakes ?? 24;
  const quietMinutes = Math.ceil(n / 2);
  const trials: Trial[] = [];
  let phones: LatLon[] = [];
  for (let k = 0; k < n; k++) {
    const q = quake(input, model, people, r);
    trials.push(q.trial);
    phones = q.phones;
    yield (k + 1) / (n + quietMinutes);
  }
  let falseAlerts = 0;
  for (let k = 0; k < quietMinutes; k++) {
    if (quietMinute(input, r)) falseAlerts++;
    yield (n + k + 1) / (n + quietMinutes);
  }

  const declared = trials.filter((t) => t.declaredS !== null);
  const shaken = trials.flatMap((t) => t.warnings);
  const warned = shaken.filter((w) => w > 0);
  return {
    trials,
    phones,
    summary: {
      phones: input.phones,
      detected: declared.length / n,
      medianDeclaredS: median(declared.map((t) => t.declaredS!)),
      medianErrKm: median(trials.flatMap((t) => (t.errKm === null ? [] : [t.errKm]))),
      warned: shaken.length ? warned.length / shaken.length : null,
      medianWarningS: median(warned),
      falseAlerts,
      quietMinutes,
    },
  };
}
