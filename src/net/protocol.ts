import { finalizeEvent, validateEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { coarsen } from '../core/geo';
import type { Phase } from '../core/physics';
import type { DetectorOutput } from '../core/sensor';

/**
 * Tremor's wire format: ordinary signed Nostr events, so any public relay can carry them.
 *  - pick (kind 4578): "shaking started here at t", sent half a second after the onset, with
 *    the wave the phone felt first (ph: P or S; events without it count as P).
 *  - retraction (kind 5, NIP-09 deletion of a pick): "that was footsteps / a door / my hand".
 *  - trigger (kind 4579): the phone's confirmed verdict, with peak acceleration.
 *  - heartbeat (kind 34579, parameterised-replaceable): "I'm alive, here, this noisy, and
 *    listening since". Relays keep only the latest per node, so late viewers see the whole
 *    network at once. One with sps 0 says the phone has stopped listening.
 */
const KIND_PICK = 4578;
const KIND_TRIGGER = 4579;
const KIND_HEARTBEAT = 34579;
const KIND_DELETION = 5;
const TAG = 'tremor';
export const HEARTBEAT_EVERY_MS = 60_000;
/** Events dated further ahead than this are refused: they would never expire. */
const MAX_FUTURE_MS = 5 * 60_000;

export interface Heartbeat {
  lat: number;
  lon: number;
  /** Background noise RMS, m/s². */
  noise: number;
  /** Samples per second the phone delivers; 0 once it has stopped listening. */
  sps: number;
  /** When the phone started listening without a break, ms since epoch. */
  since?: number;
}

export interface PickReport {
  lat: number;
  lon: number;
  /** Onset, ms since epoch (phone clock). */
  t: number;
  /** The wave the phone felt: P (up and down) or S (side to side). P when not given. */
  phase?: Phase;
}

export interface TriggerReport extends PickReport {
  /** Peak acceleration, m/s². */
  pga: number;
  /** Seconds of strong shaking. */
  dur: number;
}

interface Base {
  id: string;
  node: string;
  /** Signed creation time, ms. */
  at: number;
}
export type Message =
  | (Base & { type: 'heartbeat'; data: Heartbeat })
  | (Base & { type: 'pick'; data: PickReport })
  | (Base & { type: 'trigger'; data: TriggerReport; pick: string | null })
  | (Base & { type: 'retract'; pick: string });

const nowS = () => Math.floor(Date.now() / 1000);

export function signHeartbeat(sk: Uint8Array, hb: Heartbeat, at = nowS()): Event {
  return finalizeEvent(
    {
      kind: KIND_HEARTBEAT,
      created_at: at,
      tags: [['d', TAG], ['t', TAG]],
      content: JSON.stringify({ v: 1, ...coarsen(hb), noise: +hb.noise.toFixed(4), sps: Math.round(hb.sps), since: hb.since && Math.round(hb.since) }),
    },
    sk,
  );
}

export function signPick(sk: Uint8Array, p: PickReport, at = Math.floor(p.t / 1000)): Event {
  return finalizeEvent(
    { kind: KIND_PICK, created_at: at, tags: [['t', TAG]], content: JSON.stringify({ v: 1, ...coarsen(p), t: Math.round(p.t), ph: p.phase ?? 'P' }) },
    sk,
  );
}

export function signRetraction(sk: Uint8Array, pickId: string, reason: string, at = nowS()): Event {
  return finalizeEvent(
    { kind: KIND_DELETION, created_at: at, tags: [['e', pickId], ['k', String(KIND_PICK)], ['t', TAG]], content: reason },
    sk,
  );
}

export function signTrigger(sk: Uint8Array, tr: TriggerReport, pickId?: string, at = Math.floor(tr.t / 1000)): Event {
  return finalizeEvent(
    {
      kind: KIND_TRIGGER,
      created_at: at,
      tags: [['t', TAG], ...(pickId ? [['e', pickId]] : [])],
      content: JSON.stringify({ v: 1, ...coarsen(tr), t: Math.round(tr.t), ph: tr.phase ?? 'P', pga: +tr.pga.toFixed(4), dur: +tr.dur.toFixed(2) }),
    },
    sk,
  );
}

/**
 * What a phone signs for one detector output: a pick, then either the retraction of that pick
 * (`open`) or a trigger linked to it. Null for a rejection with no pick out: nothing to withdraw.
 * Retractions are dated when the phone gave up on the pick, the others at their onset.
 */
export function signOutput(sk: Uint8Array, loc: { lat: number; lon: number }, out: DetectorOutput, open?: string): Event | null {
  if (out.kind === 'reject') return open ? signRetraction(sk, open, out.reason, Math.floor(out.at / 1000)) : null;
  const p = { lat: loc.lat, lon: loc.lon, t: out.t, phase: out.phase };
  return out.kind === 'pick' ? signPick(sk, p) : signTrigger(sk, { ...p, pga: out.pga, dur: out.durS }, open);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi;
const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const KINDS = [KIND_PICK, KIND_TRIGGER, KIND_HEARTBEAT, KIND_DELETION];

/** Verify signature and shape. Anything malformed, forged or implausible returns null. */
export function parse(ev: Event): Message | null {
  if (!validateEvent(ev) || !KINDS.includes(ev.kind) || ev.created_at * 1000 > Date.now() + MAX_FUTURE_MS) return null;
  if (!ev.tags.some((t) => t[0] === 't' && t[1] === TAG)) return null;
  // Verify a plain copy: nostr-tools caches a "verified" flag on event objects it has seen.
  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) return null;
  const base = { id: ev.id, node: ev.pubkey, at: ev.created_at * 1000 };
  const ref = ev.tags.find((t) => t[0] === 'e')?.[1];

  if (ev.kind === KIND_DELETION) return hex64(ref) ? { ...base, type: 'retract', pick: ref } : null;

  let c: Record<string, unknown>;
  try {
    c = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (!c || c.v !== 1 || !inRange(c.lat, -90, 90) || !inRange(c.lon, -180, 180)) return null;
  // Re-coarsen on receipt too: a modified client cannot make us display a precise home location.
  const loc = coarsen({ lat: c.lat, lon: c.lon });
  if (ev.kind === KIND_HEARTBEAT) {
    if (!inRange(c.noise, 0, 50) || !inRange(c.sps, 0, 1000)) return null;
    const since = inRange(c.since, 0, base.at + MAX_FUTURE_MS) ? c.since : undefined;
    return { ...base, type: 'heartbeat', data: { ...loc, noise: c.noise, sps: c.sps, since } };
  }
  if (!finite(c.t) || Math.abs(c.t - base.at) > 120_000) return null;
  const phase = c.ph ?? 'P';
  if (phase !== 'P' && phase !== 'S') return null;
  if (ev.kind === KIND_PICK) return { ...base, type: 'pick', data: { ...loc, t: c.t, phase } };
  if (!inRange(c.pga, 0, 100) || !inRange(c.dur, 0, 120)) return null;
  return { ...base, type: 'trigger', data: { ...loc, t: c.t, phase, pga: c.pga, dur: c.dur }, pick: hex64(ref) ? ref : null };
}

/** Subscription filters for everything Tremor publishes since a given time. */
export function filters(sinceMs: number): Filter[] {
  const since = Math.floor(sinceMs / 1000);
  return [
    { kinds: [KIND_PICK, KIND_TRIGGER, KIND_DELETION], '#t': [TAG], since },
    { kinds: [KIND_HEARTBEAT], '#t': [TAG], since: since - 600 },
  ];
}
