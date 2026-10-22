import { describe, expect, it } from 'vitest';
import type { Trigger } from '../../src/core/associate';
import { earlyDetect, type Listener } from '../../src/core/early';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm } from '../../src/core/physics';
import { gauss, rng } from '../../src/core/rng';
import { SCENARIOS, simulate } from '../../src/core/scenarios';

/** Replay picks and retractions in arrival order (1 s relay latency), as a browser would see them, judging every 100 ms. */
function firstDeclaration(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const sim = simulate(s, 0);
  const arrivals: { at: number; retract: boolean; tr: Trigger }[] = [];
  for (const n of sim.nodes)
    for (const o of n.outputs) {
      const tr = { id: `${n.id}:${o.t}`, node: n.id, lat: n.lat, lon: n.lon, t: o.t, pga: 0, phase: o.kind === 'pick' ? o.phase : undefined };
      if (o.kind === 'pick') arrivals.push({ at: o.at + 1000, retract: false, tr });
      if (o.kind === 'reject') arrivals.push({ at: o.at + 1000, retract: true, tr });
    }
  arrivals.sort((a, b) => a.at - b.at);
  const active = new Map<string, Trigger>();
  let declarations = 0;
  let first: { sinceOrigin: number; errKm: number | null } | null = null;
  let i = 0;
  for (let now = arrivals[0].at; i < arrivals.length; now += 100) {
    for (; i < arrivals.length && arrivals[i].at <= now; i++) {
      const a = arrivals[i];
      if (a.retract) active.delete(a.tr.id);
      else active.set(a.tr.id, a.tr);
    }
    const { events } = earlyDetect([...active.values()], sim.nodes, now);
    if (!events.length) continue;
    declarations++;
    first ??= { sinceOrigin: (now - sim.origin) / 1000, errKm: s.truth ? distanceKm(events[0], s.truth) : null };
  }
  return { first, declarations };
}

describe('early detection from raw picks', () => {
  for (const [id, maxS] of [['napa-2014', 8], ['ridgecrest-2019', 12], ['christchurch-2011', 5]] as const) {
    it(`${id}: declared within ${maxS} s of origin, close to the truth`, () => {
      const { first } = firstDeclaration(id);
      expect(first).not.toBeNull();
      expect(first!.sinceOrigin).toBeLessThan(maxS);
      expect(first!.errKm!).toBeLessThan(15);
    });
  }

  it('concert night: footsteps and slams all evening never add up to a quake', () => {
    expect(firstDeclaration('stadium-night').declarations).toBe(0);
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
