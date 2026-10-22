import { describe, expect, it } from 'vitest';
import type { LiveNetwork } from '../../src/app/live';
import { alerts, nearYou } from '../../src/app/near';
import { offset } from '../../src/core/geo';
import type { UsgsQuake } from '../../src/net/usgs';

const you = { lat: 38.3, lon: -122.3 };
const now = Date.UTC(2026, 9, 22, 8);
const quake = (id: string, mag: number, km: number, depthKm: number): UsgsQuake => ({ id, mag, depthKm, place: id, time: now - 60_000, url: '', ...offset(you, km, 0) });
const live = (usgs: UsgsQuake[]) => ({ early: [], events: [], feltClusters: [], usgs }) as unknown as LiveNetwork;

describe('shaking near you', () => {
  it('puts a small quake close by at weak at most, and leaves out one too weak to feel here', () => {
    // An M2.0 5 km away and 2 km deep, an M2.6 there, and an M1.0 90 km away.
    const near = nearYou(live([quake('m2', 2, 5, 2), quake('m26', 2.6, 5, 2), quake('m1', 1, 90, 5)]), you, now);
    expect(near.map((x) => [x.kind === 'usgs' && x.place, x.level])).toEqual([
      ['m2', 1],
      ['m26', 2],
    ]);
  });

  it('alerts only for shaking an instrument confirmed that people here would notice, never for what people say they felt', () => {
    const at = { km: 10, time: now };
    expect(alerts({ ...at, kind: 'usgs', mag: 4.5, place: 'x', level: 2 })).toBe(true);
    expect(alerts({ ...at, kind: 'confirmed', mag: 5, level: 3 })).toBe(true);
    expect(alerts({ ...at, kind: 'usgs', mag: 3, place: 'x', level: 1 })).toBe(false);
    expect(alerts({ ...at, kind: 'provisional', mag: 5, level: 4 })).toBe(false);
    expect(alerts({ ...at, kind: 'felt', people: 3, places: 3, level: 5 })).toBe(false);
  });
});
