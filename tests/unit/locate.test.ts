import { describe, expect, it } from 'vitest';
import { coarsen, distanceKm, offset, type LatLon } from '../../src/core/geo';
import { locate, uncertainty, type Arrival } from '../../src/core/locate';
import { VP_KMS, VS_KMS, hypocentralKm, magnitudeFrom, pgaFor } from '../../src/core/physics';
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

  it('finds a quake 140 km beyond a small network from the gap between its P and S waves', () => {
    const r = rng(15);
    const city = offset(source, 140, 0);
    const arr = Array.from({ length: 30 }, (_, i) => {
      const p = offset(city, (r() - 0.5) * 40, (r() - 0.5) * 40);
      const phase = i % 3 ? ('S' as const) : ('P' as const);
      return { ...p, t: 100 + hypocentralKm(distanceKm(source, p)) / (phase === 'S' ? VS_KMS : VP_KMS) + 0.2 * gauss(r), phase };
    });
    expect(distanceKm(locate(arr)!, source)).toBeLessThan(15);
  });

  it('throws out a node with a badly wrong clock', () => {
    const arr = arrivals(10, 7, 0.1);
    arr[3].t += 9;
    const sol = locate(arr)!;
    expect(sol.used).not.toContain(3);
    expect(distanceKm(sol, source)).toBeLessThan(5);
  });

  it('uses the S-wave speed for arrivals a phone labelled S', () => {
    const r = rng(11);
    const arr = Array.from({ length: 10 }, () => {
      const p = offset(source, (r() - 0.5) * 60, (r() - 0.5) * 60);
      return { ...p, t: 100 + hypocentralKm(distanceKm(source, p)) / VS_KMS + 0.1 * gauss(r), phase: 'S' as const };
    });
    const sol = locate(arr)!;
    expect(distanceKm(sol, source)).toBeLessThan(4);
    expect(Math.abs(sol.t0 - 100)).toBeLessThan(0.5);
  });

  it('combines P arrivals from close phones with S arrivals from far ones', () => {
    const r = rng(12);
    const arr = Array.from({ length: 14 }, (_, i) => {
      const near = i < 5;
      const p = offset(source, (r() - 0.5) * (near ? 20 : 120), (r() - 0.5) * (near ? 20 : 120));
      const hyp = hypocentralKm(distanceKm(source, p));
      return { ...p, t: 100 + hyp / (near ? VP_KMS : VS_KMS) + 0.1 * gauss(r), phase: near ? ('P' as const) : ('S' as const) };
    });
    const sol = locate(arr)!;
    expect(distanceKm(sol, source)).toBeLessThan(4);
    expect(sol.used).toHaveLength(14);
  });

  it('needs at least three arrivals', () => {
    expect(locate(arrivals(2, 1, 0))).toBeNull();
  });

  it('magnitude relation inverts exactly', () => {
    for (const m of [3, 5, 7]) for (const r of [5, 40, 200]) expect(magnitudeFrom(pgaFor(m, r), r)).toBeCloseTo(m, 6);
  });
});

describe('how far off a location could be', () => {
  const C = { lat: 35, lon: -118 };
  function quake(seed: number, phones: number, spreadKm: number, awayKm: number, waves: 'P' | 'S' | 'both', mag = 5) {
    const r = rng(seed);
    const a = r() * 2 * Math.PI;
    const src = offset(C, awayKm * Math.cos(a), awayKm * Math.sin(a));
    const depth = 5 + 10 * r();
    const arr: Arrival[] = Array.from({ length: phones }, () => {
      const q = r() * 2 * Math.PI;
      const d = (spreadKm / 2) * Math.sqrt(r());
      const p = coarsen(offset(C, d * Math.cos(q), d * Math.sin(q)));
      const hyp = Math.hypot(distanceKm(src, p), depth);
      const phase = waves === 'both' ? (r() < 0.5 ? 'P' : 'S') : waves;
      return { ...p, t: 100 + hyp / (phase === 'S' ? VS_KMS : VP_KMS) + 0.12 * gauss(r), pga: pgaFor(mag, hyp) * 10 ** (0.15 * gauss(r)), phase };
    });
    const sol = locate(arr)!;
    const u = uncertainty(
      sol.used.map((i) => arr[i]),
      sol,
    );
    const middle = { lat: arr.reduce((s, x) => s + x.lat, 0) / phones, lon: arr.reduce((s, x) => s + x.lon, 0) / phones };
    const honest = (p: LatLon) => distanceKm(sol, p) <= u.km || (u.mayBeFarther && distanceKm(p, middle) > distanceKm(sol, middle));
    return { src, sol, u, covered: honest(src) };
  }

  it('is a few km when the phones surround the quake', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { u, covered } = quake(seed, 20, 40, 0, 'P');
      expect(u.km).toBeLessThan(6);
      expect(u.mayBeFarther).toBe(false);
      expect(covered).toBe(true);
    }
  });

  it('owns up to it when a few phones close together hear a quake from far away', () => {
    for (const seed of [1, 2, 3]) {
      const { sol, u, covered } = quake(seed, 10, 5, 80, 'S', 6);
      // The times alone cannot say how far it is, so the place is a guess and the magnitude too low,
      expect(sol.mag!).toBeLessThan(5);
      // and it says so: it may be farther, and much bigger.
      expect(u.mayBeFarther).toBe(true);
      expect(u.km).toBeGreaterThan(40);
      expect(u.mag![1]).toBeGreaterThanOrEqual(5.5);
      expect(covered).toBe(true);
    }
  });

  it('is right about nine times in ten, and so is its magnitude range', () => {
    let trials = 0;
    let covered = 0;
    let magCovered = 0;
    for (const waves of ['P', 'both'] as const)
      for (const spread of [5, 25])
        for (const phones of [6, 20])
          for (const away of [0, 15, 40])
            for (let seed = 1; seed <= 4; seed++) {
              const mag = 4 + seed / 2;
              const q = quake(seed * 97 + phones + spread + away, phones, spread, away, waves, mag);
              trials++;
              if (q.covered) covered++;
              // The relation behind magnitudes is good to about half a unit at best.
              if (mag >= q.u.mag![0] - 0.5 && mag <= q.u.mag![1] + 0.5) magCovered++;
            }
    expect(covered / trials).toBeGreaterThan(0.85);
    expect(magCovered / trials).toBeGreaterThan(0.85);
  });
});
