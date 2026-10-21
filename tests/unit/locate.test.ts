import { describe, expect, it } from 'vitest';
import { distanceKm, offset } from '../../src/core/geo';
import { locate } from '../../src/core/locate';
import { VP_KMS, hypocentralKm, magnitudeFrom, pgaFor } from '../../src/core/physics';
import { gauss, rng } from '../../src/core/rng';

const source = { lat: 37.8, lon: -122.3 };

function arrivals(n: number, seed: number, noiseS: number, spreadKm = 80) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const p = offset(source, (r() - 0.3) * spreadKm, (r() - 0.6) * spreadKm);
    const hyp = hypocentralKm(distanceKm(source, p));
    return { ...p, t: 100 + hyp / VP_KMS + noiseS * gauss(r), pga: pgaFor(5.5, hyp) };
  });
}

describe('epicentre grid search', () => {
  it('recovers an exact source from noiseless arrivals', () => {
    const sol = locate(arrivals(8, 1, 0))!;
    expect(distanceKm(sol, source)).toBeLessThan(0.5);
    expect(sol.t0).toBeCloseTo(100, 1);
    expect(sol.rms).toBeLessThan(0.05);
    expect(sol.mag).toBeCloseTo(5.5, 1);
  });

  it('stays within a few km with realistic phone clock noise (0.2 s)', () => {
    for (const seed of [2, 3, 4, 5, 6]) {
      const sol = locate(arrivals(15, seed, 0.2))!;
      expect(distanceKm(sol, source)).toBeLessThan(6);
      expect(Math.abs(sol.t0 - 100)).toBeLessThan(1);
    }
  });

  it('gets the direction right when the source is well outside a small network', () => {
    const r = rng(9);
    const city = offset(source, 60, 40);
    const arr = Array.from({ length: 12 }, () => {
      const p = offset(city, (r() - 0.5) * 30, (r() - 0.5) * 30);
      return { ...p, t: hypocentralKm(distanceKm(source, p)) / VP_KMS + 0.1 * gauss(r) };
    });
    // A 30 km network 70 km from the source cannot pin distance precisely, but must point at it.
    const sol = locate(arr)!;
    const bearing = (p: { lat: number; lon: number }) => Math.atan2(p.lon - city.lon, p.lat - city.lat);
    expect(Math.abs(bearing(sol) - bearing(source))).toBeLessThan(0.2);
    expect(distanceKm(sol, source)).toBeLessThan(45);
  });

  it('throws out a node with a badly wrong clock', () => {
    const arr = arrivals(10, 7, 0.1);
    arr[3].t += 9;
    const sol = locate(arr)!;
    expect(sol.used).not.toContain(3);
    expect(distanceKm(sol, source)).toBeLessThan(5);
  });

  it('needs at least three arrivals', () => {
    expect(locate(arrivals(2, 1, 0))).toBeNull();
  });

  it('magnitude relation inverts exactly', () => {
    for (const m of [3, 5, 7]) for (const r of [5, 40, 200]) expect(magnitudeFrom(pgaFor(m, r), r)).toBeCloseTo(m, 6);
  });
});
