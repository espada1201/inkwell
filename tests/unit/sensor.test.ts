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
