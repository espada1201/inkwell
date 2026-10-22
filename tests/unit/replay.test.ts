import { describe, expect, it } from 'vitest';
import { Replay, type ReplayNodeView } from '../../src/app/replay';
import { ORIGIN_OFFSET_S, SCENARIOS } from '../../src/core/scenarios';

const loaded = (id: string) => {
  const r = new Replay();
  r.load(SCENARIOS.find((s) => s.id === id)!);
  return r;
};

/** The verdict a phone reached on one of its picks, if it has reached one. */
const verdictOf = (n: ReplayNodeView, t: number) => (n.trigger?.t === t ? n.trigger : n.rejects.find((x) => x.t === t));

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
      for (r.seek(0); r.vt < r.duration; r.advance(100)) {
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
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    r.seek(r.duration / 2);
    expect(sum(r.counts().withdrawn)).toBe(rejects.filter((x) => x.at <= r.vt).length);
    r.seek(r.duration);
    const { confirmed, withdrawn } = r.counts();
    expect(sum(withdrawn)).toBe(rejects.length);
    expect(confirmed).toBe(r.nodes.filter((n) => n.trigger).length);
    for (const reason of withdrawn.keys()) expect(rejects.some((x) => x.reason === reason)).toBe(true);
  });

  it("dates the first pick of a quake from the quake's own waves", () => {
    const r = loaded('napa-2014');
    r.seek(r.duration);
    expect(r.firstPickAt!).toBeGreaterThan(ORIGIN_OFFSET_S * 1000);
    expect(r.firstPickAt!).toBeLessThan(r.declared!.at);
  });
});
