import { generateSecretKey, type Event } from 'nostr-tools/pure';
import type { LiveNetwork } from '../src/app/live';
import { distanceKm, offset, type LatLon } from '../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../src/core/physics';
import { rng } from '../src/core/rng';
import { parse, signHeartbeat, signPick, signRetraction, signTrigger, type Message } from '../src/net/protocol';

/** A city of simulated phones and what they send in a quake, as verified messages: no signatures, so a crowd of ten thousand costs nothing to make. */
export interface Crowd {
  phones: number;
  epicentre: LatLon;
  heartbeats: Message[];
  /** Picks and retractions of the shaken phones, and of the ones a footstep tripped, in the order they would arrive. */
  picks: Message[];
  /** Confirmed reports of the picks that held. */
  triggers: Message[];
}

const CITY: LatLon = { lat: 37.9, lon: -122.3 };
const RADIUS_KM = 80;
const MAG = 5.5;
const hex = (n: number, salt: number) => (n * 4 + salt).toString(16).padStart(64, '0');

/**
 * `phones` phones spread over a disc of 80 km around one city, all listening. An M5.5 starts 40 s
 * before `now` at the middle; each phone picks with the chance its shaking suggests, a quarter of
 * those picks are withdrawn, and 2% of the others send a footstep pick of their own and withdraw it.
 */
export function crowd(phones: number, now = Date.now()): Crowd {
  const r = rng(phones);
  const origin = now - 40_000;
  const epicentre = offset(CITY, 3, -2);
  const heartbeats: Message[] = [];
  const picks: [number, Message][] = [];
  const triggers: [number, Message][] = [];
  let ids = 0;
  const id = () => hex(++ids, 1);
  for (let i = 0; i < phones; i++) {
    const node = hex(i + 1, 0);
    const rad = RADIUS_KM * Math.sqrt(r());
    const a = 2 * Math.PI * r();
    const at = offset(CITY, rad * Math.cos(a), rad * Math.sin(a));
    const heard = Math.floor(now - 30_000 * r() - 50_000);
    heartbeats.push({ id: id(), node, at: heard, type: 'heartbeat', data: { ...at, noise: 0.01, sps: 50, since: origin - 3600_000 } });
    const hyp = hypocentralKm(distanceKm(epicentre, at));
    const pga = pgaFor(MAG, hyp);
    const pick = (t: number) => {
      const p: Message = { id: id(), node, at: Math.floor(t), type: 'pick', data: { ...at, t, phase: 'P' } };
      picks.push([t + 1000, p]);
      return p.id;
    };
    const withdraw = (pickId: string, t: number) => picks.push([t, { id: id(), node, at: Math.floor(t), type: 'retract', pick: pickId, reason: 'footsteps' }]);
    if (r() < Math.min(1, pga / 0.3)) {
      const t = origin + (hyp / VP_KMS) * 1000 + (r() - 0.5) * 400;
      const pickId = pick(t);
      if (r() < 0.25) withdraw(pickId, t + 20_000);
      else triggers.push([t + 20_000, { id: id(), node, at: Math.floor(t), type: 'trigger', pick: pickId, data: { ...at, t, phase: 'P', pga, dur: 8 } }]);
    } else if (r() < 0.02) {
      const t = now - 30_000 * r() - 20_000;
      withdraw(pick(t), t + 20_000);
    }
  }
  const inOrder = (xs: [number, Message][]) => xs.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return { phones, epicentre, heartbeats, picks: inOrder(picks), triggers: inOrder(triggers) };
}

/** CPU milliseconds this process has used: other work on the machine does not count against it. */
const ms = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const timed = <T>(f: () => T): [T, number] => {
  const t = ms();
  const out = f();
  return [out, ms() - t];
};

/** What checking a relay's heartbeats costs, ms each: parse (signature included) over `n` signed ones. */
export function verifyCost(n = 200): number {
  const events = Array.from({ length: n }, () => signHeartbeat(generateSecretKey(), { lat: 37.9, lon: -122.3, noise: 0.01, sps: 50 }));
  return timed(() => events.forEach((e) => parse(e)!))[1] / n;
}

export interface Timings {
  /** Taking in every heartbeat, total ms. */
  heartbeats: number;
  /** Taking in every pick, retraction and trigger, total ms. */
  messages: number;
  /** A recompute after each sixth of the picks and triggers: the slowest and the sum, ms. */
  recomputeMax: number;
  recomputeSum: number;
  /** A recompute with nothing new, ms. */
  recomputeRepeat: number;
  /** What each screen redraw asks the model for: every phone's state and the activity trace, ms. */
  screen: number;
  prune: number;
  events: number;
  provisional: number;
}

/** Run a crowd through a live network the way relays would: heartbeats, then picks and triggers in sixths with a recompute after each. */
export function measure(c: Crowd, live: LiveNetwork): Timings {
  const [, heartbeats] = timed(() => c.heartbeats.forEach((m) => live.receive(m)));
  const rest = [...c.picks, ...c.triggers];
  let messages = 0;
  const recomputes: number[] = [];
  const batches = 6;
  const per = Math.ceil(rest.length / batches);
  for (let b = 0; b < batches; b++) {
    messages += timed(() => rest.slice(b * per, (b + 1) * per).forEach((m) => live.receive(m)))[1];
    recomputes.push(timed(() => live.recompute())[1]);
  }
  const repeat = timed(() => live.recompute())[1];
  const screen = timed(() => (live.nodeStates(), live.activity()))[1];
  const prune = timed(() => (live as unknown as { prune(): void }).prune())[1];
  return {
    heartbeats,
    messages,
    recomputeMax: Math.max(...recomputes),
    recomputeSum: recomputes.reduce((s, x) => s + x, 0),
    recomputeRepeat: repeat,
    screen,
    prune,
    events: live.events.length,
    provisional: live.provisional.length,
  };
}

/** The crowd's messages as signed Nostr events, in order: heartbeats, then picks with their retractions, then triggers. Signing is slow (a few ms each). */
export function signedCrowd(c: Crowd): { heartbeats: Event[]; picks: Event[]; triggers: Event[] } {
  const keys = new Map<string, Uint8Array>();
  const key = (node: string) => keys.get(node) ?? (keys.set(node, generateSecretKey()), keys.get(node)!);
  const signedPick = new Map<string, string>();
  const sign = (m: Message): Event => {
    const sk = key(m.node);
    if (m.type === 'heartbeat') return signHeartbeat(sk, m.data, Math.floor(m.at / 1000));
    if (m.type === 'pick') {
      const ev = signPick(sk, m.data);
      signedPick.set(m.id, ev.id);
      return ev;
    }
    if (m.type === 'retract') return signRetraction(sk, signedPick.get(m.pick)!, m.reason ?? 'footsteps', Math.floor(m.at / 1000));
    if (m.type === 'trigger') return signTrigger(sk, m.data, m.pick ? signedPick.get(m.pick) : undefined);
    throw new Error(`no ${m.type} in a crowd`);
  };
  return { heartbeats: c.heartbeats.map(sign), picks: c.picks.map(sign), triggers: c.triggers.map(sign) };
}
