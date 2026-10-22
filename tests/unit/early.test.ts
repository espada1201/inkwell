import { describe, expect, it } from 'vitest';
import { Replay } from '../../src/app/replay';
import type { Trigger } from '../../src/core/associate';
import { confirmedEvents, earlyDetect, type Listener } from '../../src/core/early';
import { coarsen, distanceKm, offset, type LatLon } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { gauss, rng } from '../../src/core/rng';
import { SCENARIOS, sinceOrigin } from '../../src/core/scenarios';

/** The Replay tab's own run of a scenario, start to finish: when and where the network first declared it. */
function firstDeclaration(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const r = new Replay();
  r.load(s);
  r.seek(r.duration);
  return r.declared && { sinceOrigin: sinceOrigin(r.declared.at), errKm: s.truth ? distanceKm(r.declared.event, s.truth) : null };
}

describe('early detection from raw picks', () => {
  for (const [id, maxS] of [['napa-2014', 8], ['ridgecrest-2019', 12], ['christchurch-2011', 5]] as const) {
    it(`${id}: declared within ${maxS} s of origin, close to the truth`, () => {
      const first = firstDeclaration(id);
      expect(first).not.toBeNull();
      expect(first!.sinceOrigin).toBeLessThan(maxS);
      expect(first!.errKm!).toBeLessThan(15);
    });
  }

  it('concert night: footsteps and slams all evening never add up to a quake', () => {
    expect(firstDeclaration('stadium-night')).toBeNull();
  });

  it('phones that stayed quiet veto an epicentre next to them', () => {
    const src = { lat: 35, lon: -118 };
    const now = Date.UTC(2026, 0, 1, 0, 1);
    const t0 = now - 12_000;
    const ring = (km: number, n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, ...offset(src, km * Math.cos((i / n) * 6.28), km * Math.sin((i / n) * 6.28)) }));
    const pickers = ring(40, 5, 'p');
    const picks: Trigger[] = pickers.map((p) => ({ ...p, node: p.id, t: t0 + (hypocentralKm(distanceKm(src, p)) / VP_KMS) * 1000, pga: 0 }));
    expect(earlyDetect(picks, pickers, now).events).toHaveLength(1);
    // Ten phones much closer to that epicentre heard nothing: it cannot have been a quake there.
    const quiet = ring(10, 10, 'q');
    expect(earlyDetect(picks, [...pickers, ...quiet], now).events).toHaveLength(0);
  });

  it('declares a distant quake that only some of the phones felt, once dozens agree', () => {
    const src = { lat: 35, lon: -118 };
    const city = offset(src, 90, 30);
    const r = rng(21);
    const phones = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, ...offset(city, 40 * (r() - 0.5), 40 * (r() - 0.5)) }));
    const t0 = Date.UTC(2026, 0, 1);
    // Shaking close to the phones' noise floor: four in ten notice the P wave.
    const picks: Trigger[] = phones
      .filter(() => r() < 0.4)
      .map((p) => ({ ...p, node: p.id, t: t0 + (hypocentralKm(distanceKm(src, p)) / VP_KMS + 0.2 * gauss(r)) * 1000, pga: 0 }));
    const now = Math.max(...picks.map((p) => p.t)) + 1500;
    const evs = earlyDetect(picks, phones, now).events;
    expect(evs).toHaveLength(1);
    const bearing = (p: { lat: number; lon: number }) => Math.atan2(p.lon - city.lon, p.lat - city.lat);
    expect(Math.abs(bearing(evs[0]) - bearing(src))).toBeLessThan(0.3);
  });
});

describe('confirmed events face the phones that were listening', () => {
  // A distant quake shakes a city near what a phone can notice, so most phones stay quiet. They
  // are no evidence against it: none of them was due to feel more than weak shaking.
  it('confirms a distant quake that only a quarter of the phones felt', () => {
    const src = { lat: 35, lon: -118 };
    const city = offset(src, 80, 0);
    const r = rng(31);
    const phones = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, ...offset(city, 30 * (r() - 0.5), 30 * (r() - 0.5)) }));
    const t0 = Date.UTC(2026, 0, 1);
    const triggers: Trigger[] = phones
      .filter(() => r() < 0.25)
      .map((p) => {
        const hyp = hypocentralKm(distanceKm(src, p));
        return { ...p, node: p.id, t: t0 + (hyp / VP_KMS + 0.12 * gauss(r)) * 1000, pga: pgaFor(5, hyp), phase: 'P' as const };
      });
    const evs = confirmedEvents(triggers, triggers, () => phones, t0 + 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0].triggers.length).toBeGreaterThan(20);
  });
});

describe('the quiet phones have their say before anything is declared', () => {
  const T = Date.UTC(2026, 0, 1, 0, 1);
  const C = { lat: 35, lon: -118 };
  const pickAt = (p: Listener, t: number): Trigger => ({ ...p, node: p.id, t, pga: 0 });
  /** Judge every 100 ms, seeing each pick a second after its onset, as a browser would. */
  const declarations = (picks: Trigger[], phones: Listener[], from: number, to: number) => {
    let n = 0;
    for (let now = from; now <= to; now += 100) n += earlyDetect(picks.filter((p) => p.t + 1000 <= now), phones, now).events.length;
    return n;
  };

  it('waits for the phones the wave has not reached yet, then stands down when they stay quiet', () => {
    // A 4×4 grid 1.2 km apart. Its corners pick as if a quake were under the middle.
    const phones = Array.from({ length: 16 }, (_, i) => ({ id: `g${i}`, ...offset(C, 1.2 * ((i % 4) - 1.5), 1.2 * (Math.floor(i / 4) - 1.5)) }));
    const arrival = (p: Listener) => T + (hypocentralKm(distanceKm(C, p)) / VP_KMS) * 1000;
    const corners = [0, 3, 12, 15].map((i) => pickAt(phones[i], arrival(phones[i])));
    const seen = Math.max(...corners.map((p) => p.t)) + 1000;
    // The phones in the middle would have felt it a moment later: too soon to say.
    expect(earlyDetect(corners, phones, seen)).toMatchObject({ events: [], waiting: true });
    // They stayed quiet.
    expect(earlyDetect(corners, phones, seen + 2000)).toMatchObject({ events: [], waiting: false });
    // A quake there would have reached every one of them.
    expect(earlyDetect(phones.map((p) => pickAt(p, arrival(p))), phones, seen).events).toHaveLength(1);
  });

  it('phones in one or two buildings never make a quake, however many of them shake', () => {
    // Phones share coarse locations, so a building is one spot, and one truck or door shakes it all.
    const next = { lat: C.lat + 0.01, lon: C.lon };
    for (const spots of [[C], [C, next]]) {
      const phones = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, ...spots[i % spots.length] }));
      const picks = phones.map((p, i) => pickAt(p, T + 40 * i));
      expect(declarations(picks, phones, T + 1000, T + 10_000)).toBe(0);
    }
  });

  it('a crowd jumping in a stadium is no quake, even when a third of the phones there feel it', () => {
    const cells = [0, 1, 2].map((k) => ({ lat: C.lat, lon: C.lon + 0.01 * k }));
    const phones = Array.from({ length: 47 }, (_, i) => ({ id: `v${i}`, ...cells[i % 3] }));
    const r = rng(5);
    const picks = phones.slice(0, 16).map((p) => pickAt(p, T + 500 * r()));
    expect(declarations(picks, phones, T + 1000, T + 10_000)).toBe(0);
  });
});

describe('the declaration rule at its edges', () => {
  const T = Date.UTC(2026, 0, 1, 0, 1);
  const C = { lat: 35, lon: -118 };
  const arrival = (p: LatLon) => T + (hypocentralKm(distanceKm(C, p)) / VP_KMS) * 1000;
  const ring = (km: number, n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, ...coarsen(offset(C, km * Math.cos((i / n) * 2 * Math.PI), km * Math.sin((i / n) * 2 * Math.PI))) }));

  it('picks from four phones in three places declare a quake', () => {
    // Two of the four share a building, so one coarse cell.
    const spots = [offset(C, -6, 0), offset(C, 6, 0), offset(C, 0, 6)].map(coarsen);
    const phones = [0, 1, 2, 2].map((k, i) => ({ id: `f${i}`, ...spots[k] }));
    const picks: Trigger[] = phones.map((p) => ({ ...p, node: p.id, t: arrival(p), pga: 0 }));
    expect(earlyDetect(picks, phones, Math.max(...picks.map((p) => p.t)) + 2000).events).toHaveLength(1);
  });

  it('from sixteen places, a third of the phones that should have felt it is enough', () => {
    // Sixteen phones in sixteen places felt it; thirty-two closer ones stayed quiet.
    const felt = ring(12, 16, 'y');
    const quiet = [...ring(6, 16, 'q'), ...ring(9, 16, 'r')];
    const triggers: Trigger[] = felt.map((p) => ({ ...p, node: p.id, t: arrival(p), pga: pgaFor(5, hypocentralKm(distanceKm(C, p))), phase: 'P' }));
    expect(confirmedEvents(triggers, triggers, () => [...felt, ...quiet], T + 60_000)).toHaveLength(1);
  });
});
