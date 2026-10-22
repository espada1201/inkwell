import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { LiveNetwork } from '../../src/app/live';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { parse, signFelt, signHeartbeat, signPick, signRetraction, signTrigger, type Message } from '../../src/net/protocol';
import type { Transport } from '../../src/net/transport';

class NullTransport implements Transport {
  publish() {}
  subscribe(_f: Filter[], _cb: (ev: Event) => void) {
    return () => {};
  }
  statuses() {
    return [];
  }
  onStatus() {}
  close() {}
}
const fetchNone = (async () => new Response('{}', { status: 503 })) as typeof fetch;

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

/** What a reader of the network can see, with every collection in a fixed order. */
function seen(live: LiveNetwork, probes: number[]) {
  const quake = (e: LiveNetwork['events'][number]) => ({ members: ids(e.triggers), lat: round(e.lat), lon: round(e.lon), time: Math.round(e.time), mag: e.mag === null ? null : round(e.mag) });
  const order = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
  return JSON.stringify({
    nodes: [...live.nodes.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((n) => ({ id: n.id, lat: n.lat, lon: n.lon, sps: n.sps, lastSeen: n.lastSeen, lastTrigger: n.lastTrigger, online: probes.map((t) => live.isOnline(n, t)) })),
    picks: ids([...live.picks.values()]),
    triggers: ids(live.triggers),
    events: order(live.events.map(quake)),
    early: order(live.early.map(quake)),
    felt: ids(live.felt),
    clusters: order(live.feltClusters.map((c) => ({ reports: ids(c.reports), lvl: c.lvl, time: c.time, lat: c.lat, lon: c.lon }))),
  });
}

/** Time given after each message: past the 200 ms batch, so the recompute it queued has run before the next arrives. */
const BETWEEN_MS = 250;

/**
 * Feeds `pre` in order, then `msgs` in every order, from the clock at `now` and with BETWEEN_MS
 * after each message, and returns the orders that leave the network looking different from the
 * first one. The network is read as its own recomputes left it.
 */
function divergences(pre: Message[], msgs: [string, Message][], now: number) {
  const probes = [...new Set([...pre, ...msgs.map(([, m]) => m)].flatMap((m) => [m.at, 'data' in m && 't' in m.data ? m.data.t : m.at]))].sort();
  let first: string | null = null;
  const bad: string[] = [];
  for (const order of permutations(msgs)) {
    vi.setSystemTime(now);
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    for (const m of [...pre, ...order.map(([, m]) => m)]) {
      live.receive(m);
      vi.advanceTimersByTime(BETWEEN_MS);
    }
    vi.clearAllTimers();
    const s = seen(live, probes);
    if (first === null) first = s;
    else if (s !== first) bad.push(order.map(([k]) => k).join(' '));
  }
  return { first: JSON.parse(first!), bad };
}

const src = { lat: 37.9, lon: -122.3 };
function phone(i: number, t0: number) {
  const p = offset(src, Math.cos(i * 1.7) * (8 + 5 * i), Math.sin(i * 1.7) * (8 + 5 * i));
  const hyp = hypocentralKm(distanceKm(src, p));
  return { sk: generateSecretKey(), ...p, t: t0 + (hyp / VP_KMS) * 1000, pga: pgaFor(5.5, hyp) };
}
const msg = (ev: Event) => parse(ev)!;

describe('the live network converges', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('on the same picks whichever order retractions, by their author or a forger, arrive in', () => {
    const now = Date.now();
    const [a, b] = [phone(0, now - 20_000), phone(1, now - 20_000)];
    const hb = (p: typeof a) => msg(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 50, since: now - 600_000 }));
    const pa = msg(signPick(a.sk, a));
    const pb = msg(signPick(b.sk, b));
    const { first, bad } = divergences(
      [],
      [
        ['hbA', hb(a)],
        ['pickA', pa],
        ['retractA', msg(signRetraction(a.sk, pa.id, 'footsteps'))],
        ['hbB', hb(b)],
        ['pickB', pb],
        ['A retracts pickB', msg(signRetraction(a.sk, pb.id, 'footsteps'))],
      ],
      now,
    );
    expect(first.picks).toEqual([pb.id]);
    expect(bad).toEqual([]);
  });

  it('on the same confirmed quake whichever order triggers, repeats and heartbeats arrive in', () => {
    const now = Date.now();
    const ps = Array.from({ length: 4 }, (_, i) => phone(i, now - 20_000));
    const hb = (p: (typeof ps)[number], at: number) => msg(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 50, since: now - 600_000 }, Math.floor(at / 1000)));
    const tr = ps.map((p) => msg(signTrigger(p.sk, { ...p, dur: 5 })));
    const { first, bad } = divergences(
      [hb(ps[0], now - 5000), hb(ps[1], now - 5000), hb(ps[2], now - 5000), tr[2]],
      [
        ['oldHbD', hb(ps[3], now - 70_000)],
        ['hbD', hb(ps[3], now - 5000)],
        ['trA', tr[0]],
        ['trB', tr[1]],
        ['trD', tr[3]],
        ['trB again', tr[1]],
      ],
      now,
    );
    expect(first.events).toHaveLength(1);
    expect(bad).toEqual([]);
  });

  it('on the same provisional quake whichever order picks, withdrawals and repeats arrive in', () => {
    const now = Date.now();
    const ps = Array.from({ length: 5 }, (_, i) => phone(i, now - 20_000));
    const hb = (p: (typeof ps)[number]) => msg(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 50, since: now - 600_000 }));
    const pk = ps.map((p) => msg(signPick(p.sk, p)));
    const { first, bad } = divergences(
      [...ps.map(hb), pk[0], pk[1]],
      [
        ['pickC', pk[2]],
        ['pickD', pk[3]],
        ['pickE', pk[4]],
        ['retractE', msg(signRetraction(ps[4].sk, pk[4].id, 'footsteps'))],
        ['pickE again', pk[4]],
        ['A retracts pickD', msg(signRetraction(ps[0].sk, pk[3].id, 'footsteps'))],
      ],
      now,
    );
    expect(first.early).toHaveLength(1);
    expect(bad).toEqual([]);
  });

  it('on no provisional quake where phones that stayed quiet are heard from, before the picks or after them', () => {
    const now = Date.now();
    const t0 = now - 15_000;
    const at = (east: number, north: number) => {
      const p = offset(src, east, north);
      return { sk: generateSecretKey(), ...p, t: t0 + (hypocentralKm(distanceKm(src, p)) / VP_KMS) * 1000 };
    };
    // Four phones around the source felt it start; two within 4 km of it felt nothing.
    const pickers = [at(10, 0), at(-12, 3), at(2, 14), at(-4, -15)];
    const quiet = [at(3, 3), at(-3, 2)];
    const hb = (p: (typeof pickers)[number]) => msg(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 50, since: now - 600_000 }));
    const picks = pickers.map((p) => msg(signPick(p.sk, p)));
    // Without the quiet phones, the four picks make a quake.
    const alone = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    for (const m of [...pickers.map(hb), ...picks]) alone.receive(m);
    vi.advanceTimersByTime(BETWEEN_MS);
    expect(alone.early).toHaveLength(1);
    const { first, bad } = divergences(
      pickers.map(hb),
      [['hbQuiet1', hb(quiet[0])], ['hbQuiet2', hb(quiet[1])], ...picks.map((m, i): [string, Message] => [`pick${'ABCD'[i]}`, m])],
      now,
    );
    expect(first.early).toEqual([]);
    expect(bad).toEqual([]);
  });

  it('on the same felt shakings whichever order reports arrive in', () => {
    const now = Date.now();
    const t0 = now - 30 * 60_000;
    const keys = Array.from({ length: 4 }, () => generateSecretKey());
    const felt = (sk: Uint8Array, dLat: number, dt: number, lvl: number) => msg(signFelt(sk, { lat: src.lat + dLat, lon: src.lon, t: t0 + dt, lvl }, Math.floor((t0 + dt) / 1000)));
    const { first, bad } = divergences(
      [],
      [
        ['A weak', felt(keys[0], 0, 0, 2)],
        ['A strong 5 min later', felt(keys[0], 0, 5 * 60_000, 4)],
        ['B', felt(keys[1], 0.05, 60_000, 4)],
        ['C', felt(keys[2], 0.1, 60_000, 4)],
        ['D', felt(keys[3], 0.15, 120_000, 2)],
      ],
      now,
    );
    expect(first.clusters).toHaveLength(1);
    expect(bad).toEqual([]);
  });
});
