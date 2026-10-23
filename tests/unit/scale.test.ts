import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { LiveNetwork } from '../../src/app/live';
import { distanceKm } from '../../src/core/geo';
import { ModelMirror, computeModel, type Compute } from '../../src/app/model';
import type { Transport } from '../../src/net/transport';
import { crowd, measure, type Timings } from '../scale';

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

/**
 * CPU milliseconds, about three times what a crowd of that size cost when these were set (a
 * recompute ran 180 ms at most for 3,000 phones, where it ran 300 ms before the scan of every
 * pick for each pick, and the full association for each unchanged recompute, went away), so a
 * slower machine passes and a return to scans of everything does not.
 */
const BUDGET: Record<number, Partial<Record<keyof Timings, number>>> = {
  1000: { heartbeats: 150, messages: 100, recomputeMax: 300, recomputeSum: 1200, recomputeRepeat: 50, screen: 30, prune: 30 },
  3000: { heartbeats: 300, messages: 150, recomputeMax: 600, recomputeSum: 2400, recomputeRepeat: 60, screen: 60, prune: 50 },
  // Measured at 10,000 (the most phones kept): heartbeats 15-22, messages 125-170, recompute max 665-720, sum 2500-2700, repeat 11-15, screen 9, prune 6. A repeat of 1,200 was the old code.
  10000: { heartbeats: 100, messages: 500, recomputeMax: 2200, recomputeSum: 8000, recomputeRepeat: 45, screen: 30, prune: 20 },
};

describe('a crowd of phones in a quake', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  for (const n of [1000, 3000, 10_000]) {
    it(`${n} phones: heartbeats, picks and withdrawals are taken in, and the quake found, within the time budget`, { timeout: 120_000 }, () => {
      const c = crowd(n);
      const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
      const t = measure(c, live);
      for (const [k, limit] of Object.entries(BUDGET[n])) expect(t[k as keyof Timings], `${k} for ${n} phones, CPU ms`).toBeLessThan(limit);
      expect(live.nodes.size).toBe(n);
      expect(live.events).toHaveLength(1);
      expect(live.provisional.map((d) => d.outcome)).toEqual(['confirmed']);
      expect(distanceKm(live.events[0], c.epicentre)).toBeLessThan(10);
      expect(live.events[0].triggers.length).toBeGreaterThan(c.triggers.length * 0.8);
    });
  }

  it('3000 phones: worked out apart from the page, the same quake, members and provisional outcomes come out', { timeout: 120_000 }, async () => {
    const c = crowd(3000);
    const run = async (compute?: Compute) => {
      const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone, undefined, compute);
      for (const m of [...c.heartbeats, ...c.picks, ...c.triggers]) live.receive(m);
      live.recompute();
      if (compute) await vi.waitFor(() => expect(live.events).toHaveLength(1), { timeout: 60_000 });
      return JSON.stringify({ events: live.events.map((e) => [e.id, e.lat, e.lon, e.time, e.mag, e.triggers.map((t) => t.id)]), early: live.early.map((e) => [e.id, e.triggers.map((t) => t.id)]), outcomes: live.provisional.map((d) => d.outcome) });
    };
    const mirror = new ModelMirror();
    expect(await run(async (delta) => structuredClone(computeModel(mirror.apply(structuredClone(delta)))))).toBe(await run());
  });
});
