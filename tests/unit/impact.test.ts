import { describe, expect, it } from 'vitest';
import { distanceKm, offset } from '../../src/core/geo';
import { shakeGrid, sRadiusKm, warningNear, warningSummary } from '../../src/core/impact';
import { G, VS_KMS, intensityLevel } from '../../src/core/physics';

const epi = { lat: 38, lon: -122 };

describe('warning time', () => {
  it('S-wave radius matches travel time through a buried source', () => {
    expect(sRadiusKm(10, 0)).toBeCloseTo(10 * VS_KMS, 6);
    expect(sRadiusKm(1, 10)).toBe(0);
    expect(Math.hypot(sRadiusKm(8, 10), 10) / VS_KMS).toBeCloseTo(8, 6);
  });

  it('phones beyond the blind zone get positive warning, inside it negative', () => {
    const near = { ...offset(epi, 5, 0), pga: 3 };
    const far = { ...offset(epi, 60, 0), pga: 0.5 };
    const w = warningSummary([near, far], epi, 10, 5);
    expect(w.alertAt).toBe(5);
    expect(w.blindKm).toBeCloseTo(sRadiusKm(5, 10), 6);
    expect(w.warnings[0]).toBeLessThan(0);
    expect(w.warnings[1]).toBeCloseTo(Math.hypot(distanceKm(epi, far), 10) / VS_KMS - 5, 1);
    expect(w.warned).toBe(1);
  });

  it('phones that barely felt anything are not counted', () => {
    expect(warningSummary([{ ...offset(epi, 100, 0), pga: 0.01 }], epi, 10, 5).warnings).toEqual([]);
  });
});

describe('warning near a place', () => {
  const napa = offset(epi, 9, 0);
  const phones = [
    { ...offset(napa, 3, 0), pga: 3 },
    { ...offset(napa, 0, 8), pga: 3 },
    { ...offset(napa, 40, 0), pga: 3 },
    { ...offset(napa, 5, 5), pga: 0.01 },
  ];

  it('keeps each phone with its place, distance from the epicentre and seconds, felt or not', () => {
    const w = warningSummary(phones, epi, 10, 5);
    expect(w.phones).toHaveLength(4);
    expect(w.phones[0].epicentreKm).toBeCloseTo(distanceKm(epi, phones[0]), 6);
    expect(w.phones[0].s).toBeCloseTo(w.warnings[0], 6);
    expect(w.phones.map((p) => p.felt)).toEqual([true, true, true, false]);
    expect(w.phones.filter((p) => p.felt).map((p) => p.s)).toEqual(w.warnings);
  });

  it('takes only the phones that felt it within the radius of the place', () => {
    const w = warningSummary(phones, epi, 10, 5);
    const near = warningNear(w.phones, napa, 15)!;
    expect(near.n).toBe(2);
    expect(near.max).toBeLessThan(0);
    expect(near.min).toBeLessThanOrEqual(near.max);
    expect(near.warned).toBe(0);
    expect(warningNear(w.phones, napa, 60)!.n).toBe(3);
  });

  it('is null where no phone that felt it is near', () => {
    expect(warningNear(warningSummary(phones, epi, 10, 5).phones, offset(napa, 200, 0), 15)).toBeNull();
  });
});

describe('shaking map', () => {
  it('stays close to the measurements near each phone and blends between them', () => {
    const a = { ...offset(epi, 0, 0), pga: 2 };
    const b = { ...offset(epi, 8, 0), pga: 0.2 };
    const cells = shakeGrid([a, b], 4, 15);
    const at = (p: typeof a) => cells.reduce((best, c) => (distanceKm(c, p) < distanceKm(best, p) ? c : best));
    expect(at(a).pga).toBeGreaterThan(1.6);
    expect(at(b).pga).toBeLessThan(0.3);
    const mid = at({ ...offset(epi, 4, 0), pga: 0 });
    expect(mid.pga).toBeGreaterThan(at(b).pga);
    expect(mid.pga).toBeLessThan(at(a).pga);
  });

  it('leaves areas without phones blank', () => {
    const cells = shakeGrid([{ ...epi, pga: 1 }], 4, 10);
    expect(cells.every((c) => distanceKm(c, epi) <= 10)).toBe(true);
    expect(shakeGrid([])).toEqual([]);
  });

  it('maps PGA to the intensity scale', () => {
    expect(intensityLevel(0.001)).toBe(0); // not felt
    expect(intensityLevel(0.05 * G)).toBe(3); // moderate
    expect(intensityLevel(0.5 * G)).toBe(6); // severe
  });
});
