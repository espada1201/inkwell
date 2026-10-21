import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { coarsen } from '../core/geo';

/**
 * Tremor's wire format: ordinary signed Nostr events, so any public relay can carry them.
 *  - trigger (kind 4579, regular, stored): "I felt shaking starting at t".
 *  - heartbeat (kind 34579, parameterised-replaceable): "I'm alive, here, this noisy".
 *    Relays keep only the latest per node, so late viewers see the whole network at once.
 */
export const KIND_TRIGGER = 4579;
export const KIND_HEARTBEAT = 34579;
export const TAG = 'tremor';
export const HEARTBEAT_EVERY_MS = 60_000;

export interface Heartbeat {
  lat: number;
  lon: number;
  /** Background noise RMS, m/s². */
  noise: number;
  /** Samples per second the phone delivers. */
  sps: number;
}

export interface TriggerReport {
  lat: number;
  lon: number;
  /** Onset, ms since epoch (phone clock). */
  t: number;
  /** Peak acceleration, m/s². */
  pga: number;
  /** Seconds of strong shaking. */
  dur: number;
}

export type Message =
  | { type: 'heartbeat'; id: string; node: string; at: number; data: Heartbeat }
  | { type: 'trigger'; id: string; node: string; at: number; data: TriggerReport };

const nowS = () => Math.floor(Date.now() / 1000);

export function signHeartbeat(sk: Uint8Array, hb: Heartbeat, at = nowS()): Event {
  const c = coarsen(hb);
  return finalizeEvent(
    {
      kind: KIND_HEARTBEAT,
      created_at: at,
      tags: [['d', TAG], ['t', TAG]],
      content: JSON.stringify({ v: 1, ...c, noise: +hb.noise.toFixed(4), sps: Math.round(hb.sps) }),
    },
    sk,
  );
}

export function signTrigger(sk: Uint8Array, tr: TriggerReport, at = Math.floor(tr.t / 1000)): Event {
  const c = coarsen(tr);
  return finalizeEvent(
    {
      kind: KIND_TRIGGER,
      created_at: at,
      tags: [['t', TAG]],
      content: JSON.stringify({ v: 1, ...c, t: Math.round(tr.t), pga: +tr.pga.toFixed(4), dur: +tr.dur.toFixed(2) }),
    },
    sk,
  );
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi;

/** Verify signature and shape. Anything malformed, forged or implausible returns null. */
export function parse(ev: Event): Message | null {
  if (ev.kind !== KIND_TRIGGER && ev.kind !== KIND_HEARTBEAT) return null;
  if (!ev.tags.some((t) => t[0] === 't' && t[1] === TAG)) return null;
  // Verify a plain copy: nostr-tools caches a "verified" flag on event objects it has seen.
  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) return null;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (!c || c.v !== 1 || !inRange(c.lat, -90, 90) || !inRange(c.lon, -180, 180)) return null;
  // Re-coarsen on receipt too: a modified client cannot make us display a precise home location.
  const loc = coarsen({ lat: c.lat, lon: c.lon });
  const base = { id: ev.id, node: ev.pubkey, at: ev.created_at * 1000 };
  if (ev.kind === KIND_HEARTBEAT) {
    if (!inRange(c.noise, 0, 50) || !inRange(c.sps, 1, 1000)) return null;
    return { ...base, type: 'heartbeat', data: { ...loc, noise: c.noise, sps: c.sps } };
  }
  if (!finite(c.t) || Math.abs(c.t - base.at) > 120_000 || !inRange(c.pga, 0, 100) || !inRange(c.dur, 0, 120)) return null;
  return { ...base, type: 'trigger', data: { ...loc, t: c.t, pga: c.pga, dur: c.dur } };
}

/** Subscription filters for everything Tremor publishes since a given time. */
export function filters(sinceMs: number): Filter[] {
  const since = Math.floor(sinceMs / 1000);
  return [
    { kinds: [KIND_TRIGGER], '#t': [TAG], since },
    { kinds: [KIND_HEARTBEAT], '#t': [TAG], since: since - 600 },
  ];
}
