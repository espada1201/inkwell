import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { LiveNetwork } from '../../src/app/live';
import { ModelMirror, ModelSender, computeModel, type ModelDelta, type ModelInput } from '../../src/app/model';
import type { Onset } from '../../src/core/early';
import { rng } from '../../src/core/rng';
import type { Message } from '../../src/net/protocol';
import type { Transport } from '../../src/net/transport';

class NullTransport implements Transport {
  publish() {}
  subscribe(_f: Filter[] | (() => Filter[]), _cb: (ev: Event) => void) {
    return () => {};
  }
  statuses() {
    return [];
  }
  onStatus() {}
  close() {}
}
const fetchNone = (async () => new Response('{}', { status: 503 })) as typeof fetch;

type Inside = { prune(): void; heard: Onset[] };
const hex = (n: number, salt: number) => (n * 4 + salt).toString(16).padStart(64, '0');
const MIN = 60_000;

/** What the worker must be holding after each delta: the page's own state, in the page's own order. */
const expected = (live: LiveNetwork, now: number): ModelInput => ({
  now,
  nodes: [...live.nodes.values()].map(({ id, lat, lon, sps, since, firstSeen, lastSeen }) => ({ id, lat, lon, sps, since, firstSeen, lastSeen })),
  picks: [...live.picks.values()],
  triggers: [...live.triggers],
  heard: [...(live as unknown as Inside).heard],
});

describe('the worker keeps the same network as the page, delta by delta', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** A sender and a mirror joined by structured clone, as the page and its worker are. */
  const wire = (live: LiveNetwork) => {
    const sender = new ModelSender();
    const mirror = new ModelMirror();
    const step = () => {
      const delta = sender.delta(Date.now(), live.nodes, live.picks, live.triggers, (live as unknown as Inside).heard);
      step.last = delta;
      return mirror.apply(structuredClone(delta));
    };
    step.last = undefined as ModelDelta | undefined;
    return step;
  };

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`random messages, replays, withdrawals, pruning and caps between deltas (seed ${seed})`, { timeout: 60_000 }, () => {
      vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
      const r = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
      const step = wire(live);
      const nodes = Array.from({ length: 40 }, (_, i) => hex(i + 1, 0));
      const sent: Extract<Message, { type: 'pick' }>[] = [];
      let ids = 0;
      const id = () => hex(++ids, 1);
      const at = (node: string) => ({ lat: 35 + (nodes.indexOf(node) % 7) * 0.1, lon: -118 + (nodes.indexOf(node) % 5) * 0.1 });
      const ops = [
        () => {
          const node = pick(nodes);
          live.receive({ id: id(), node, at: Date.now() - Math.floor(r() * 3000), type: 'heartbeat', data: { ...at(node), noise: 0.01, sps: r() < 0.15 ? 0 : 50, ...(r() < 0.5 ? { since: Date.now() - 3600_000 } : {}) } });
        },
        () => {
          const node = pick(nodes);
          const t = Date.now() - Math.floor(r() * 8 * MIN);
          const m: Message = { id: id(), node, at: t, type: 'pick', data: { ...at(node), t, phase: r() < 0.8 ? 'P' : 'S' } };
          sent.push(m);
          live.receive(m);
        },
        // The same pick again, as a relay replays it after a reconnect: after it was dropped it is a new pick that arrives last.
        () => sent.length && live.receive(pick(sent)),
        () => {
          const node = pick(nodes);
          const t = Date.now() - Math.floor(r() * 30_000);
          const named = sent.length && r() < 0.5 ? pick(sent).id : undefined;
          live.receive({ id: id(), node, at: t, type: 'trigger', pick: named ?? null, data: { ...at(node), t, phase: 'P', pga: 0.2, dur: 5 } });
        },
        () => {
          const p = sent.length ? pick(sent) : undefined;
          const node = p && r() < 0.8 ? p.node : pick(nodes);
          live.receive({ id: id(), node, at: Date.now(), type: 'retract', pick: p?.id ?? id(), reason: 'footsteps' });
        },
        () => {
          vi.setSystemTime(Date.now() + Math.floor(r() * (r() < 0.1 ? 130 * MIN : 3 * MIN)));
          (live as unknown as Inside).prune();
        },
      ];
      // Weighted: mostly messages, now and then time passing.
      const weighted = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5].map((i) => ops[i]);
      // What the run covered, so a seed that never reaches the awkward cases does not pass for one that does.
      const reached = { full: 0, droppedAndSentAgain: 0, nodesGone: 0, picksGone: 0, triggersGone: 0 };
      for (let round = 0; round < 400; round++) {
        for (let k = Math.ceil(r() * 12); k > 0; k--) pick(weighted)();
        expect(step(), `round ${round}`).toEqual(expected(live, Date.now()));
        const d = step.last!;
        if (live.nodes.size > 5 && live.picks.size > 5 && live.triggers.length > 5) reached.full++;
        if (d.dropPicks.some((id) => d.addPicks.some((p) => p.id === id)) || d.dropNodes.some((id) => d.setNodes.some((n) => n.id === id))) reached.droppedAndSentAgain++;
        reached.nodesGone += d.dropNodes.length;
        reached.picksGone += d.dropPicks.length;
        reached.triggersGone += d.dropTriggers.length;
      }
      expect(reached.full).toBeGreaterThan(50);
      expect(reached.nodesGone).toBeGreaterThan(0);
      expect(reached.picksGone).toBeGreaterThan(0);
      expect(reached.triggersGone).toBeGreaterThan(0);
    });
  }

  it('a pick that was dropped and arrives again between two deltas is the new pick, last in its order', () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const step = wire(live);
    const now = Date.now();
    for (const n of [1, 2]) live.receive({ id: hex(n, 0), node: hex(n, 0), at: now, type: 'heartbeat', data: { lat: 35, lon: -118, noise: 0.01, sps: 50 } });
    const pick = (n: number, t: number): Message => ({ id: hex(n, 1), node: hex(n, 0), at: t, type: 'pick', data: { lat: 35, lon: -118, t, phase: 'P' } });
    // `a` is nearly five minutes old, and goes with the next prune; a relay then sends it again.
    const a = pick(1, now - 299_000);
    const b = pick(2, now - 100_000);
    live.receive(a);
    live.receive(b);
    expect(step().picks.map((p) => p.id)).toEqual([a.id, b.id]);
    vi.setSystemTime(now + 5000);
    (live as unknown as Inside).prune();
    live.receive(a);
    expect(live.picks.size).toBe(2);
    const held = step();
    expect(held.picks.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(held).toEqual(expected(live, Date.now()));
  });

  it('a phone dropped and heard again between two deltas is the new one, last in its order, with what its new heartbeat says', () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const step = wire(live);
    const now = Date.now();
    const beat = (n: number, at: number, lat: number): Message => ({ id: hex(n + 100, 1), node: hex(n, 0), at, type: 'heartbeat', data: { lat, lon: -118, noise: 0.01, sps: 50 } });
    live.receive(beat(1, now - 3 * 3600_000 + 60_000, 35));
    live.receive(beat(2, now, 35.1));
    live.receive(beat(3, now, 35.2));
    // The first one is 2 hours silent, so the next prune drops it. Meanwhile one more is heard, and the first speaks again.
    expect(step().nodes.map((n) => n.id)).toEqual([hex(1, 0), hex(2, 0), hex(3, 0)]);
    vi.setSystemTime(now + 61_000);
    (live as unknown as Inside).prune();
    live.receive(beat(4, now + 61_000, 35.3));
    live.receive(beat(1, now + 61_000, 36));
    const held = step();
    expect(held.nodes.map((n) => [n.id, n.lat])).toEqual([[hex(2, 0), 35.1], [hex(3, 0), 35.2], [hex(4, 0), 35.3], [hex(1, 0), 36]]);
    expect(held).toEqual(expected(live, Date.now()));
  });

  it('onsets pruned from the middle of the heard list while more arrive do not leave the worker with the wrong ones', () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const step = wire(live);
    const inside = live as unknown as Inside;
    const now = Date.now();
    for (let n = 1; n <= 6; n++) live.receive({ id: hex(n, 0), node: hex(n, 0), at: now, type: 'heartbeat', data: { lat: 35, lon: -118, noise: 0.01, sps: 50 } });
    const trig = (n: number, t: number): Message => ({ id: hex(n, 1), node: hex(n, 0), at: t, type: 'trigger', pick: null, data: { lat: 35, lon: -118, t, phase: 'P', pga: 0.2, dur: 5 } });
    // The newest first, the oldest in the middle: onset times need not arrive in order.
    live.receive(trig(1, now - 10_000));
    live.receive(trig(2, now - 119 * MIN));
    live.receive(trig(3, now - 9000));
    step();
    vi.setSystemTime(now + 3 * MIN);
    inside.prune();
    live.receive(trig(4, now + 3 * MIN - 5000));
    live.receive(trig(5, now + 3 * MIN - 4000));
    expect(step().heard).toEqual(inside.heard);
    expect(inside.heard).toHaveLength(4);
  });

  it('keeps up past every cap: 10,000 phones, 5,000 picks, 5,000 triggers and 10,000 onsets', { timeout: 120_000 }, () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const step = wire(live);
    const now = Date.now();
    let ids = 0;
    const id = () => hex(++ids, 1);
    const hear = (n: number) => live.receive({ id: id(), node: hex(n, 0), at: now - n, type: 'heartbeat', data: { lat: 35 + (n % 90) * 0.01, lon: -118, noise: 0.01, sps: 50 } });
    for (let n = 1; n <= 10_000; n++) {
      hear(n);
      if (n % 2500 === 0) expect(step()).toEqual(expected(live, now));
    }
    // 10,001 and on: the phone silent longest goes.
    for (let n = 10_001; n <= 10_100; n++) hear(n);
    expect(live.nodes.size).toBe(10_000);
    expect(step()).toEqual(expected(live, now));
    const t = (n: number) => now - 100_000 + n;
    for (let n = 0; n < 6200; n++) {
      const node = hex(5000 + (n % 220), 0);
      live.receive({ id: id(), node, at: t(n), type: 'pick', data: { lat: 35, lon: -118, t: t(n), phase: 'P' } });
      live.receive({ id: id(), node, at: t(n), type: 'trigger', pick: null, data: { lat: 35, lon: -118, t: t(n), phase: 'P', pga: 0.2, dur: 5 } });
      if (n % 1500 === 0) expect(step()).toEqual(expected(live, now));
    }
    expect(live.picks.size).toBe(5000);
    expect(live.triggers.length).toBe(5000);
    expect((live as unknown as Inside).heard.length).toBe(10_000);
    expect(step()).toEqual(expected(live, now));
  });

  it('works out the same quakes from what the worker holds as from what the page holds', () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const r = rng(11);
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const step = wire(live);
    const now = Date.now();
    for (let n = 1; n <= 30; n++) live.receive({ id: hex(n, 0), node: hex(n, 0), at: now - 1000, type: 'heartbeat', data: { lat: 35 + r() * 0.3, lon: -118 + r() * 0.3, noise: 0.01, sps: 50, since: now - 3600_000 } });
    for (let n = 1; n <= 30; n++) {
      const t = now - 20_000 + n * 40;
      live.receive({ id: hex(n, 1), node: hex(n, 0), at: t, type: 'pick', data: { lat: 35 + r() * 0.3, lon: -118 + r() * 0.3, t, phase: 'P' } });
    }
    const mine = step();
    const page = { ...expected(live, now) };
    const out = (i: ModelInput) => JSON.stringify(computeModel(i), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
    expect(out(mine)).toBe(out(page));
  });
});
