import { describe, expect, it } from 'vitest';
import { associate, type Trigger } from '../../src/core/associate';
import { distanceKm, offset, type LatLon } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { gauss, rng } from '../../src/core/rng';

const T0 = Date.UTC(2026, 9, 21, 12);

function quake(src: LatLon, t0: number, n: number, seed: number, tag: string): Trigger[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const p = offset(src, (r() - 0.5) * 100, (r() - 0.5) * 100);
    const hyp = hypocentralKm(distanceKm(src, p));
    return { id: `${tag}${i}`, node: `${tag}n${i}`, ...p, t: t0 + (hyp / VP_KMS + 0.15 * gauss(r)) * 1000, pga: pgaFor(5, hyp) };
  });
}

describe('association', () => {
  it('turns a coherent set of triggers into one located event', () => {
    const src = { lat: 35, lon: -118 };
    const evs = associate(quake(src, T0, 10, 1, 'a'));
    expect(evs).toHaveLength(1);
    expect(distanceKm(evs[0], src)).toBeLessThan(6);
    expect(Math.abs(evs[0].time - T0)).toBeLessThan(800);
    expect(evs[0].triggers).toHaveLength(10);
  });

  it('separates two simultaneous quakes far apart', () => {
    const a = { lat: 35, lon: -118 };
    const b = { lat: 38, lon: -122.5 };
    const evs = associate([...quake(a, T0, 8, 2, 'a'), ...quake(b, T0 + 2000, 8, 3, 'b')]);
    expect(evs).toHaveLength(2);
    const near = (p: LatLon) => evs.some((e) => distanceKm(e, p) < 8);
    expect(near(a) && near(b)).toBe(true);
  });

  it('ignores scattered unrelated triggers (footsteps across a city)', () => {
    const r = rng(4);
    const city = { lat: 34.05, lon: -118.25 };
    const noise: Trigger[] = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`,
      node: `n${i}`,
      ...offset(city, (r() - 0.5) * 30, (r() - 0.5) * 30),
      t: T0 + r() * 600_000,
      pga: 0.1,
    }));
    expect(associate(noise)).toEqual([]);
  });

  it('requires the minimum number of distinct nodes', () => {
    const trig = quake({ lat: 35, lon: -118 }, T0, 2, 5, 'a');
    expect(associate(trig)).toEqual([]);
    // the same node triggering three times is still only one node
    const same = quake({ lat: 35, lon: -118 }, T0, 3, 6, 'b').map((t) => ({ ...t, node: 'solo' }));
    expect(associate(same)).toEqual([]);
  });

  it('keeps unrelated chatter out of a real event', () => {
    const src = { lat: 35, lon: -118 };
    const stray: Trigger = { id: 'stray', node: 'stray', ...offset(src, 30, 30), t: T0 + 40_000, pga: 0.1 };
    const evs = associate([...quake(src, T0, 9, 7, 'a'), stray]);
    expect(evs).toHaveLength(1);
    expect(evs[0].triggers.map((t) => t.id)).not.toContain('stray');
  });

  // Was cubic: 1,000 phones took 11 s, which would freeze the live map after a city quake.
  it('handles a dense city of 1,000 phones and stray picks quickly', { timeout: 3000 }, () => {
    const src = { lat: 35, lon: -118 };
    const r = rng(8);
    const stray: Trigger[] = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, node: `s${i}`, ...offset(src, (r() - 0.5) * 80, (r() - 0.5) * 80), t: T0 + (r() - 0.5) * 120_000, pga: 0.1 }));
    const evs = associate([...quake(src, T0, 1000, 9, 'a'), ...stray]);
    const big = evs.filter((e) => e.triggers.length > 10);
    expect(big).toHaveLength(1);
    expect(distanceKm(big[0], src)).toBeLessThan(3);
    expect(big[0].triggers.length).toBeGreaterThan(950);
  });
});
