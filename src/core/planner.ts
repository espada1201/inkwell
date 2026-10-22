import type { Trigger } from './associate';
import { MIN_PICKS, confirmedEvents, earlyDetect, type Listener, type Onset } from './early';
import { coarsen, distanceKm, offset, type LatLon } from './geo';
import { DEFAULT_DEPTH_KM, VP_KMS, VS_KMS, hypocentralKm, intensityLevel, pgaFor } from './physics';
import { respond, type PhoneModel } from './phonemodel';
import { gauss, rng } from './rng';
import { upperMedian } from './stats';
import { CLOCK_SIGMA_MS, RELAY_LATENCY_MS, alertS, pointInDisk, siteScatter, type Arrival } from './simnet';

/**
 * Network planner: how many phones does a city need?
 *
 * Hundreds of quakes against thousands of phones is too much to synthesise sample by sample,
 * so each phone draws its behaviour from a model measured on the real detector (see
 * phonemodel.ts). Everything downstream is the real network code: early detection from picks,
 * association, location and warning time.
 */

/**
 * The planner judges on frames this long, and only when a pick is new or quiet phones have
 * come due. The live app judges 200 ms after each batch of messages and Replay at every
 * arrival, so a planned declaration can come up to one frame later than theirs: a quarter
 * second of fidelity traded for thousands of simulated quakes.
 */
const FRAME_MS = 250;
/** Phones bumped, walked past or picked up in any given minute: an assumption, not a measurement. */
export const DISTURBED_PER_MINUTE = 0.05;
/** Above this many confirmed triggers, locate from an even sample of them (the app uses all). */
const MAX_CONFIRM = 300;
/** Residents count toward the share warned once they shake at least moderately (intensity 3). */
const SHAKEN_LEVEL = 3;

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
  /** Quake-free minutes of bumps in which to count false alerts. */
  quietMinutes?: number;
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
  /** Seconds after the rupture the first alert typically reached phones, when declared. */
  medianAlertS: number | null;
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

/** A network catches a kind of quake once it detects this share of the simulated ones. */
export const RELIABLY = 0.9;

/**
 * The smallest network in an ascending sweep that catches its quakes reliably: undefined
 * while a smaller count is still being simulated, null once none of them does.
 */
export function enoughPhones(sweep: number[], points: Summary[]): Summary | null | undefined {
  // shortcut: the answer is one of the sweep's steps, not a search between them; bisect between the last miss and the first hit when a sharper count is wanted.
  for (const n of sweep) {
    const s = points.find((p) => p.phones === n);
    if (!s) return undefined;
    if (s.detected >= RELIABLY) return s;
  }
  return null;
}

/** Where the plan's phones are, and the coarse positions the network knows them by. */
function phoneNodes(input: PlanInput, r: () => number) {
  const phones = Array.from({ length: input.phones }, () => pointInDisk(input.city, input.radiusKm, r));
  return { phones, nodes: phones.map((p, i): Listener => ({ id: `p${i}`, ...coarsen(p) })) };
}

/** Evenly spaced points standing in for where people live. */
function residents(c: LatLon, radiusKm: number, target = 150): LatLon[] {
  const step = Math.sqrt((Math.PI * radiusKm * radiusKm) / target);
  const out: LatLon[] = [];
  for (let e = -radiusKm; e <= radiusKm; e += step) for (let n = -radiusKm; n <= radiusKm; n += step) if (Math.hypot(e, n) <= radiusKm) out.push(offset(c, e, n));
  return out;
}

/** A bump at a random time in [fromS, toS]: a pick, then a retraction once the phone has vetted it. */
function bump(node: Listener, r: () => number, fromS: number, toS: number): [Arrival, Arrival] {
  const t = (fromS + (toS - fromS) * r()) * 1000;
  const tr: Trigger = { id: `${node.id}:b`, node: node.id, lat: node.lat, lon: node.lon, t, pga: 0 };
  return [
    { at: t + RELAY_LATENCY_MS, kind: 'pick', tr },
    { at: t + 15_000 + RELAY_LATENCY_MS, kind: 'retract', tr },
  ];
}

/** Watch arrivals the way a browser does, frame by frame, and return the first declaration at or after `from`. */
function firstDeclaration(arrivals: Arrival[], nodes: Listener[], from = -Infinity) {
  if (!arrivals.length) return null;
  arrivals.sort((a, b) => a.at - b.at);
  const picks = new Map<string, Trigger>();
  let fresh = false;
  let waiting = false;
  let i = 0;
  for (let t = arrivals[0].at; i < arrivals.length || waiting; t += FRAME_MS) {
    for (; i < arrivals.length && arrivals[i].at <= t; i++) {
      const a = arrivals[i];
      if (a.kind === 'pick') {
        picks.set(a.tr.id, a.tr);
        fresh = true;
      } else picks.delete(a.tr.id);
    }
    // Only frames with new picks, or quiet phones newly due, can change the verdict.
    if (!(fresh || waiting) || t < from) continue;
    fresh = false;
    waiting = false;
    if (picks.size < MIN_PICKS) continue;
    const r = earlyDetect([...picks.values()], nodes, t);
    if (r.events.length) return { at: t, ev: r.events[0] };
    waiting = r.waiting;
  }
  return null;
}

function quake(input: PlanInput, model: PhoneModel, people: LatLon[], r: () => number) {
  const depth = input.depthKm ?? DEFAULT_DEPTH_KM;
  const [near, far] = input.distanceKm;
  const ang = r() * 2 * Math.PI;
  const d = Math.sqrt(near * near + (far * far - near * near) * r());
  const epi = offset(input.city, d * Math.cos(ang), d * Math.sin(ang));
  const { phones, nodes } = phoneNodes(input, r);
  const arrivals: Arrival[] = [];
  const triggers: Trigger[] = [];
  let firstPick = Infinity;

  phones.forEach((p, i) => {
    const node = nodes[i];
    const clock = CLOCK_SIGMA_MS * gauss(r);
    const hyp = hypocentralKm(distanceKm(epi, p), depth);
    const tP = hyp / VP_KMS;
    const pga = pgaFor(input.mag, hyp) * siteScatter(r);
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
    const at = t + o.sent * 1000 + RELAY_LATENCY_MS;
    arrivals.push({ at, kind: 'pick', tr });
    firstPick = Math.min(firstPick, at);
    if (o.confirmed) triggers.push(tr);
    else arrivals.push({ at: t + o.vet * 1000 + RELAY_LATENCY_MS, kind: 'retract', tr });
  });

  // False alerts are counted in quiet minutes, so only look once the P wave has reached someone.
  const dec = firstDeclaration(arrivals, nodes, firstPick);
  const declaredS = dec && dec.at / 1000;
  // The alert then travels back out through the relays to every phone.
  const alertAt = declaredS === null ? Infinity : alertS(declaredS);
  const warnings: number[] = [];
  for (const q of people) {
    const hyp = hypocentralKm(distanceKm(epi, q), depth);
    if (intensityLevel(pgaFor(input.mag, hyp)) >= SHAKEN_LEVEL) warnings.push(hyp / VS_KMS - alertAt);
  }
  let errKm: number | null = null;
  if (input.confirm && triggers.length >= MIN_PICKS) {
    // As the app does: every phone listened, and every phone that picked felt it.
    const sample = triggers.length > MAX_CONFIRM ? triggers.filter((_, i) => i % Math.ceil(triggers.length / MAX_CONFIRM) === 0) : triggers;
    const heard: Onset[] = arrivals.filter((a) => a.kind === 'pick').map((a) => a.tr);
    const ev = confirmedEvents(sample, heard, () => nodes, Infinity).sort((a, b) => b.triggers.length - a.triggers.length)[0];
    if (ev) errKm = distanceKm(ev, epi);
  }
  const trial: Trial = { epicentre: epi, declaredS, errKm, warnings };
  return { trial, phones };
}

/** A minute with no earthquake: does anyone's bump turn into a false alert? */
function quietMinute(input: PlanInput, r: () => number) {
  const { nodes } = phoneNodes(input, r);
  const arrivals = nodes.flatMap((n) => (r() < DISTURBED_PER_MINUTE ? bump(n, r, 0, 60) : []));
  return firstDeclaration(arrivals, nodes) !== null;
}

/** The planner as a sequence of steps (one simulated quake or quiet minute each), yielding progress 0..1. */
export function* simulatePlan(input: PlanInput, model: PhoneModel): Generator<number, PlanResult> {
  const r = rng(input.seed ?? 1);
  const people = residents(input.city, input.radiusKm);
  const n = input.quakes ?? 24;
  const quietMinutes = input.quietMinutes ?? 60;
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
      medianAlertS: upperMedian(declared.map((t) => alertS(t.declaredS!))),
      medianErrKm: upperMedian(trials.flatMap((t) => (t.errKm === null ? [] : [t.errKm]))),
      warned: shaken.length ? warned.length / shaken.length : null,
      medianWarningS: upperMedian(warned),
      falseAlerts,
      quietMinutes,
    },
  };
}
