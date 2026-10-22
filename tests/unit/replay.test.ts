import { describe, expect, it } from 'vitest';
import { Replay, type ReplayNodeView } from '../../src/app/replay';
import { offset } from '../../src/core/geo';
import { ORIGIN_OFFSET_S, SCENARIOS, type Scenario } from '../../src/core/scenarios';
import { RELAY_LATENCY_MS } from '../../src/core/simnet';

const loaded = (id: string) => {
  const r = new Replay();
  r.load(SCENARIOS.find((s) => s.id === id)!);
  return r;
};

/** The verdict a phone reached on one of its picks, if it has reached one. */
const verdictOf = (n: ReplayNodeView, t: number) => (n.trigger?.t === t ? n.trigger : n.rejects.find((x) => x.t === t));

/** Phones with a pick whose verdict has not reached the network by the end of the replay. */
const unresolved = (r: Replay) => r.nodes.filter((n) => n.picks.some((p) => !((verdictOf(n, p.t)?.at ?? Infinity) + RELAY_LATENCY_MS <= r.duration))).map((n) => n.id);

/** A quake from the feed replayed around a saved location `km` from it, as the Replay screen builds one: 40 phones within 30 km. */
function aroundHome(mag: number, km: number): Scenario {
  const epicentre = { lat: 37.85, lon: -122.22 };
  return {
    id: `home-${km}`, title: `M${mag}, home ${km} km away`, place: '', blurb: '',
    truth: { ...epicentre, depthKm: 8, mag, usgsId: 'x', date: '2026-10-01T00:00:00Z' },
    city: offset(epicentre, km, 0), radiusKm: 30, nodes: 40, disturbed: 0.15, seed: 12345,
  };
}

describe('the Replay tab, run headless', () => {
  it('draws a phone that withdrew an earlier pick as checking its next one', () => {
    const r = new Replay();
    const n: ReplayNodeView = {
      id: 'a', lat: 0, lon: 0, distKm: 10, trace: new Float32Array(0),
      picks: [{ t: 1000, at: 1400, phase: 'P' }, { t: 40_000, at: 40_400, phase: 'P' }],
      trigger: null,
      rejects: [{ t: 1000, at: 16_000, reason: 'impulse' }],
    };
    r.vt = 2000;
    expect(r.nodeState(n)).toBe('pick');
    r.vt = 17_000;
    expect(r.nodeState(n)).toBe('reject');
    r.vt = 30_000;
    expect(r.nodeState(n)).toBe('idle');
    r.vt = 41_000;
    expect(r.nodeState(n)).toBe('pick');
  });

  it('never draws a phone idle while it is still checking a pick', () => {
    for (const s of SCENARIOS) {
      const r = loaded(s.id);
      const wrong = new Set<string>();
      // How a phone is drawn depends only on the clock, so move the clock itself.
      for (r.vt = 0; r.vt < r.duration; r.vt += 100) {
        for (const n of r.nodes) {
          const checking = n.picks.some((p) => p.at <= r.vt && !((verdictOf(n, p.t)?.at ?? Infinity) <= r.vt));
          if (checking && r.nodeState(n) === 'idle') wrong.add(n.id);
        }
      }
      expect([...wrong], s.id).toEqual([]);
    }
  });

  it('counts confirmed phones and withdrawn picks as of the replay clock', () => {
    const r = loaded('stadium-night');
    const rejects = r.nodes.flatMap((n) => n.rejects);
    r.seek(r.duration / 2);
    expect(r.counts().withdrawn).toBe(rejects.filter((x) => x.at <= r.vt).length);
    r.seek(r.duration);
    const { confirmed, withdrawn, why } = r.counts();
    expect(withdrawn).toBe(rejects.length);
    expect(confirmed).toBe(r.nodes.filter((n) => n.trigger).length);
    for (const [reason, k] of why) expect(k).toBe(rejects.filter((x) => x.reason === reason).length);
  });

  it('plays a quake until every phone that picked has its verdict, even with the phones 130–150 km away', () => {
    const far = [[6, 130], [6, 150], [7, 130], [7, 150]].map(([mag, km]) => aroundHome(mag, km));
    for (const s of [...SCENARIOS.filter((x) => x.truth), ...far]) {
      const r = new Replay();
      r.load(s);
      expect(r.nodes.filter((n) => n.picks.length).length, s.title).toBeGreaterThan(20);
      expect(unresolved(r), s.title).toEqual([]);
    }
  });

  it('keeps the bundled records at 80 s, but for Ridgecrest, whose farthest phone feels the S wave 38 s after the origin', () => {
    expect(Object.fromEntries(SCENARIOS.map((s) => [s.id, loaded(s.id).duration / 1000]))).toEqual({ 'napa-2014': 80, 'ridgecrest-2019': 95, 'christchurch-2011': 80, 'stadium-night': 80 });
  });

  it("dates the first pick of a quake from the quake's own waves", () => {
    const r = loaded('napa-2014');
    r.seek(r.duration);
    expect(r.firstPickAt!).toBeGreaterThan(ORIGIN_OFFSET_S * 1000);
    expect(r.firstPickAt!).toBeLessThan(r.declared!.at);
  });
});
