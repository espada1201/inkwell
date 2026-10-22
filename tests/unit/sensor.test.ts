import { describe, expect, it } from 'vitest';
import { NodeDetector, type DetectorOutput } from '../../src/core/sensor';
import { synthesize, type SynthOptions } from '../../src/core/synth';

function run(o: Omit<SynthOptions, 'start' | 'durationS' | 'seed'> & { seed?: number; durationS?: number }) {
  const det = new NodeDetector(50);
  const out: DetectorOutput[] = [];
  for (const s of synthesize({ start: 0, durationS: 90, seed: 7, ...o })) {
    const r = det.push(s);
    if (r) out.push(r);
  }
  return { out, triggers: out.filter((r) => r.kind === 'trigger'), det };
}

describe('per-phone trigger', () => {
  it('stays silent on a quiet table', () => {
    for (const seed of [1, 2, 3]) expect(run({ seed }).out).toEqual([]);
  });

  it('triggers on an earthquake with onset near the P arrival', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { triggers } = run({ seed, quake: { tP: 30, tS: 34, pga: 0.6 } });
      expect(triggers).toHaveLength(1);
      expect(triggers[0].t / 1000).toBeGreaterThan(29.9);
      expect(triggers[0].t / 1000).toBeLessThan(30.6);
      expect(triggers[0].pga).toBeGreaterThan(0.3);
    }
  });

  it('triggers on S when P is too weak, still once', () => {
    const { triggers } = run({ quake: { tP: 30, tS: 31.5, pga: 0.25 } });
    expect(triggers).toHaveLength(1);
  });

  it('rejects footsteps', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { out, triggers } = run({ seed, footsteps: { t: 30, count: 10 } });
      expect(triggers).toHaveLength(0);
      expect(out.some((o) => o.kind === 'reject' && o.reason === 'footsteps')).toBe(true);
    }
  });

  it('rejects a door slam as an impulse', () => {
    for (const seed of [1, 2, 3]) {
      const { out, triggers } = run({ seed, slam: { t: 30 } });
      expect(triggers).toHaveLength(0);
      expect(out.some((o) => o.kind === 'reject' && o.reason === 'impulse')).toBe(true);
    }
  });

  it('rejects being picked up', () => {
    const { out, triggers } = run({ pickup: { t: 30 } });
    expect(triggers).toHaveLength(0);
    expect(out.some((o) => o.kind === 'reject' && o.reason === 'handling')).toBe(true);
  });

  it('raises its threshold after false alarms', () => {
    const { det } = run({ slam: { t: 30 }, durationS: 50 });
    expect(det.threshold).toBeGreaterThan(det.base);
  });

  it('ignores weak shaking under the noise floor', () => {
    expect(run({ quake: { tP: 30, tS: 34, pga: 0.03 } }).triggers).toHaveLength(0);
  });
});

describe('strong and distant quakes', () => {
  it('captures the late S-wave peak of a strong quake', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { triggers } = run({ seed, quake: { tP: 30, tS: 38, pga: 2, decayS: 8 } });
      expect(triggers).toHaveLength(1);
      expect(triggers[0].t / 1000).toBeLessThan(30.6);
      expect(triggers[0].pga).toBeGreaterThan(1.2);
    }
  });

  it('triggers on S alone when P is below the noise floor', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { triggers } = run({ seed, quake: { tP: 30, tS: 42, pga: 0.15, decayS: 6 } });
      expect(triggers).toHaveLength(1);
      expect(triggers[0].t / 1000).toBeGreaterThan(41.9);
    }
  });
});

describe('provisional picks', () => {
  it('sends a pick at the onset, long before the confirmed trigger', () => {
    const { out } = run({ quake: { tP: 30, tS: 34, pga: 0.6 } });
    const pick = out.find((o) => o.kind === 'pick')!;
    const trig = out.find((o) => o.kind === 'trigger')!;
    expect(pick.t).toBe(trig.t);
    // Sent half a second after the onset at most: long enough to tell P from S.
    expect(pick.at - pick.t).toBeLessThanOrEqual(500);
    expect(trig.at - pick.t).toBeGreaterThanOrEqual(15_000);
  });

  it('every pick is later resolved as either a trigger or a reject', () => {
    for (const o of [{ footsteps: { t: 30, count: 10 } }, { slam: { t: 30 } }, { quake: { tP: 30, tS: 34, pga: 0.6 } }]) {
      const { out } = run(o);
      const picks = out.filter((x) => x.kind === 'pick');
      const finals = out.filter((x) => x.kind !== 'pick');
      expect(picks.map((p) => p.t)).toEqual(finals.map((f) => f.t));
    }
  });

  it('withdraws its pick when the samples stop before it could check the shaking', () => {
    const det = new NodeDetector(50);
    const out: DetectorOutput[] = [];
    for (const s of synthesize({ start: 0, durationS: 90, seed: 7, quake: { tP: 30, tS: 34, pga: 0.6 } })) {
      // The tab is hidden two seconds after the onset, for ten seconds.
      if (s.t > 32_000 && s.t < 42_000) continue;
      const r = det.push(s);
      if (r) out.push(r);
    }
    const pick = out.find((o) => o.kind === 'pick')!;
    expect(out.filter((o) => o.kind !== 'pick')).toEqual([{ kind: 'reject', t: pick.t, at: 42_000, reason: 'interrupted' }]);
  });
});

describe('telling P from S by which way the phone shakes', () => {
  it('labels a strong, close quake by its P wave', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { out } = run({ seed, quake: { tP: 30, tS: 34, pga: 0.6 } });
      expect(out.find((o) => o.kind === 'pick')!.phase).toBe('P');
      expect(out.find((o) => o.kind === 'trigger')!.phase).toBe('P');
    }
  });

  it('labels a quake whose P wave was too weak to notice by its S wave', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { out } = run({ seed, quake: { tP: 30, tS: 42, pga: 0.15, decayS: 6 } });
      expect(out.find((o) => o.kind === 'pick')!.phase).toBe('S');
      expect(out.find((o) => o.kind === 'trigger')!.phase).toBe('S');
    }
  });

  it('knows which way is down however the phone lies', () => {
    // Same quake, phone propped on its side: gravity now along y, not z.
    const det = new NodeDetector(50);
    const out: DetectorOutput[] = [];
    for (const s of synthesize({ start: 0, durationS: 90, seed: 3, quake: { tP: 30, tS: 34, pga: 0.6 } })) {
      const r = det.push({ t: s.t, x: s.x, y: s.z, z: s.y });
      if (r) out.push(r);
    }
    expect(out.find((o) => o.kind === 'trigger')!.phase).toBe('P');
  });
});

