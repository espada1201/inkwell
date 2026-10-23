import { describe, expect, it } from 'vitest';
import { associate, compatible, eventUncertainty, onSphere, type Trigger } from '../../src/core/associate';
import { distanceKm, offset, type LatLon } from '../../src/core/geo';
import { VP_KMS, VS_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
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

  it('says how far off each event could be, working it out once', () => {
    const src = { lat: 35, lon: -118 };
    const [ev] = associate(quake(src, T0, 10, 1, 'a'));
    const u = eventUncertainty(ev);
    expect(distanceKm(ev, src)).toBeLessThanOrEqual(u.km);
    expect(u.km).toBeLessThan(10);
    expect(u.mag![0]).toBeLessThanOrEqual(5);
    expect(u.mag![1]).toBeGreaterThanOrEqual(ev.mag!);
    expect(eventUncertainty({ ...ev })).toBe(u);
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
    // Three arrival times can nearly always be fitted by an epicentre and an origin time.
    const trig = quake({ lat: 35, lon: -118 }, T0, 3, 5, 'a');
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

  // Phones far from a moderate quake often miss its weak P wave and trigger on the S wave.
  it('locates a quake outside the city from phones that only felt its S wave', () => {
    const src = { lat: 35, lon: -118 };
    const city = offset(src, 35, 0);
    const r = rng(12);
    const trig: Trigger[] = Array.from({ length: 20 }, (_, i) => {
      const p = offset(city, (r() - 0.5) * 30, (r() - 0.5) * 30);
      const hyp = hypocentralKm(distanceKm(src, p));
      return { id: `s${i}`, node: `n${i}`, ...p, t: T0 + (hyp / VS_KMS + 0.15 * gauss(r)) * 1000, pga: pgaFor(5, hyp), phase: 'S' as const };
    });
    const evs = associate(trig);
    expect(evs).toHaveLength(1);
    expect(distanceKm(evs[0], src)).toBeLessThan(10);
    expect(Math.abs(evs[0].mag! - 5)).toBeLessThan(0.5);
  });

  // Seen from one side, a distant quake's distance trades off against its origin time; the
  // gap between the P and the S arrivals is what pins it.
  it('places a distant quake using phones that felt its P wave and phones that felt its S wave', () => {
    const src = { lat: 35, lon: -118 };
    const city = offset(src, 100, 40);
    const r = rng(14);
    const trig: Trigger[] = Array.from({ length: 300 }, (_, i) => {
      const p = offset(city, (r() - 0.5) * 40, (r() - 0.5) * 40);
      const hyp = hypocentralKm(distanceKm(src, p));
      const phase = r() < 0.15 ? ('P' as const) : ('S' as const);
      return { id: `d${i}`, node: `n${i}`, ...p, t: T0 + (hyp / (phase === 'S' ? VS_KMS : VP_KMS) + 0.25 * gauss(r)) * 1000, pga: pgaFor(6, hyp), phase };
    });
    const evs = associate(trig);
    expect(evs).toHaveLength(1);
    expect(evs[0].triggers.filter((t) => t.phase === 'P').length).toBeGreaterThan(30);
    expect(distanceKm(evs[0], src)).toBeLessThan(8);
  });

  // Phones a few km apart cannot time a wavefront's curvature. Without a prior on distance the
  // epicentre drifted to wherever the noise fitted best, often 70 km away and magnitudes too big.
  it('places a small quake under a tight cluster of phones near them, with about the right magnitude', () => {
    const src = { lat: 35, lon: -118 };
    for (const [n, km, mag] of [[4, 2, 3.5], [5, 5, 4], [6, 3, 3.5]] as const)
      for (let seed = 1; seed <= 20; seed++) {
        const r = rng(100 + seed);
        const trig: Trigger[] = Array.from({ length: n }, (_, i) => {
          const p = offset(src, (r() - 0.5) * km, (r() - 0.5) * km);
          const hyp = hypocentralKm(distanceKm(src, p));
          return { id: `c${seed}-${i}`, node: `n${i}`, ...p, t: T0 + (hyp / VP_KMS + 0.15 * gauss(r)) * 1000, pga: pgaFor(mag, hyp) };
        });
        const [ev] = associate(trig);
        expect(distanceKm(ev, src)).toBeLessThan(15);
        expect(Math.abs(ev.mag! - mag)).toBeLessThan(1);
      }
  });

  it('two phones that felt the P wave are enough to pin a distant quake seen mostly by its S wave', () => {
    const src = { lat: 35, lon: -118 };
    const city = offset(src, 100, 0);
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(500 + seed);
      const trig: Trigger[] = Array.from({ length: 8 }, (_, i) => {
        const p = offset(city, (r() - 0.5) * 30, (r() - 0.5) * 30);
        const hyp = hypocentralKm(distanceKm(src, p));
        const phase = i < 2 ? ('P' as const) : ('S' as const);
        return { id: `d${seed}-${i}`, node: `n${i}`, ...p, t: T0 + (hyp / (phase === 'S' ? VS_KMS : VP_KMS) + 0.15 * gauss(r)) * 1000, pga: pgaFor(5, hyp), phase };
      });
      const evs = associate(trig);
      expect(evs).toHaveLength(1);
      expect(evs[0].triggers).toHaveLength(8);
      expect(distanceKm(evs[0], src)).toBeLessThan(15);
    }
  });

  // Phones near the quake felt its P wave, farther ones only its S wave: neither wave alone
  // reached four phones, but the S−P gaps pin the distance.
  it('locates a quake that three phones felt as P and three as S', () => {
    const src = { lat: 35, lon: -118 };
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(700 + seed);
      const city = offset(src, 30, 0);
      const trig: Trigger[] = Array.from({ length: 6 }, (_, i) => {
        const p = offset(city, (r() - 0.5) * 20, (r() - 0.5) * 20);
        const hyp = hypocentralKm(distanceKm(src, p));
        const phase = i < 3 ? ('P' as const) : ('S' as const);
        return { id: `m${seed}-${i}`, node: `n${i}`, ...p, t: T0 + (hyp / (phase === 'S' ? VS_KMS : VP_KMS) + 0.12 * gauss(r)) * 1000, pga: pgaFor(5, hyp), phase };
      });
      const evs = associate(trig);
      expect(evs).toHaveLength(1);
      expect(evs[0].triggers).toHaveLength(6);
      expect(distanceKm(evs[0], src)).toBeLessThan(10);
    }
  });

  it('puts close P triggers and distant S triggers from one quake into one event', () => {
    const src = { lat: 35, lon: -118 };
    const r = rng(13);
    const trig: Trigger[] = Array.from({ length: 24 }, (_, i) => {
      const far = i % 2 === 1;
      const p = offset(src, (r() - 0.5) * (far ? 140 : 30), (r() - 0.5) * (far ? 140 : 30));
      const hyp = hypocentralKm(distanceKm(src, p));
      const phase = far && hyp > 30 ? ('S' as const) : ('P' as const);
      return { id: `m${i}`, node: `n${i}`, ...p, t: T0 + (hyp / (phase === 'S' ? VS_KMS : VP_KMS) + 0.1 * gauss(r)) * 1000, pga: pgaFor(5.5, hyp), phase };
    });
    const evs = associate(trig);
    expect(evs).toHaveLength(1);
    expect(evs[0].triggers.length).toBeGreaterThan(20);
    expect(distanceKm(evs[0], src)).toBeLessThan(5);
  });

  it('finds the same quakes whatever order the triggers arrive in, even when two onsets tie', () => {
    // Relays deliver in any order, so every browser must see the same quakes. Here t2 and t4 tie, as do t1 and t5.
    const at = (id: string, s: number, lat: number, lon: number): Trigger => ({ id, node: id, lat, lon, t: T0 + s * 1000, pga: 0.5, phase: 'P' });
    const trig = [at('t0', 7, 37.933, -122.713), at('t1', 8, 38.041, -122.489), at('t2', 5, 37.647, -122.08), at('t3', 11, 37.772, -122.471), at('t4', 5, 37.772, -121.985), at('t5', 8, 38.174, -121.78)];
    const permutations = (xs: Trigger[]): Trigger[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations(xs.filter((_, j) => j !== i)).map((rest) => [x, ...rest])));
    const quakes = (ts: Trigger[]) => associate(ts, { minNodes: 3 }).map((e) => e.triggers.map((t) => t.id).sort().join());
    const seen = new Set(permutations(trig).map((order) => quakes(order).join(' | ')));
    expect([...seen]).toHaveLength(1);
  });
});

describe('the fast check of whether two triggers can be one wave', () => {
  const MAX_KM = 400;
  const TOLERANCE_S = 1.5;

  it('agrees with the great-circle distance for pairs near and far, at the poles and across the antimeridian', () => {
    const r = rng(11);
    const places: LatLon[] = [{ lat: 0, lon: 0 }, { lat: 37.8, lon: -122.3 }, { lat: -43.5, lon: 172.6 }, { lat: 66, lon: 179.95 }, { lat: 84, lon: 30 }, { lat: -89.5, lon: -10 }];
    let near = 0;
    for (let i = 0; i < 60_000; i++) {
      const a = places[i % places.length];
      const reach = [3, 40, 380, 399, 401, 420, 2000][i % 7];
      const ang = r() * 2 * Math.PI;
      const b = offset(a, Math.cos(ang) * reach * r(), Math.sin(ang) * reach * r());
      const d = distanceKm(a, b);
      const speed = i % 2 ? VP_KMS : VS_KMS;
      // Time gaps that fall inside, just inside, just outside and well outside the travel time.
      const dt = Math.max(0, d / speed + TOLERANCE_S + [-5, -0.01, 0, 1e-9, 0.01, 5][i % 6]);
      const want = d <= MAX_KM && dt <= d / speed + TOLERANCE_S;
      near += want ? 1 : 0;
      expect(compatible(a, b, onSphere(a), onSphere(b), dt, speed), `${JSON.stringify([a, b, dt, speed])}`).toBe(want);
    }
    expect(near).toBeGreaterThan(10_000);
  });
});

describe('association answers asked twice', () => {
  it('gives the same events for the same triggers, and works afresh when one more arrives', () => {
    const src = { lat: 35, lon: -118 };
    const triggers = quake(src, T0, 10, 1, 'a');
    const first = associate(triggers);
    const again = associate(triggers);
    expect(again).toEqual(first);
    // What a caller does with the answer does not reach the next one.
    again.pop();
    expect(associate(triggers)).toEqual(first);
    const more = associate([...triggers, ...quake({ lat: 40.5, lon: -118 }, T0 + 5000, 8, 2, 'b')]);
    expect(more).toHaveLength(2);
    expect(associate(triggers)).toEqual(first);
  });
});

