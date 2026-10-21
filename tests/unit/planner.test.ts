import { describe, expect, it } from 'vitest';
import { calibrate, runPlan, type PlanInput } from '../../src/core/planner';

const m6 = calibrate(6);
const m5 = calibrate(5);
const city = { lat: 41.03, lon: 28.98 };
const plan = (o: Partial<PlanInput>, model = m6) => runPlan({ city, radiusKm: 20, phones: 100, mag: 6, distanceKm: [15, 50], quakes: 8, ...o }, model).summary;

describe('phone model calibrated on the real detector', () => {
  it('never notices shaking below its noise floor and always notices strong shaking', () => {
    const picked = (level: number) => m6.cells[level].flat().filter((r) => r.delay !== null).length / m6.cells[level].flat().length;
    expect(picked(0)).toBe(0); // 0.005 m/s²
    expect(picked(2)).toBe(0); // 0.02 m/s²
    expect(picked(8)).toBe(1); // 0.55 m/s²
    expect(picked(11)).toBe(1); // 3.2 m/s²
  });

  it('confirms strong quake shaking rather than retracting it', () => {
    const strong = m6.cells.slice(8).flat(2);
    expect(strong.filter((r) => r.confirmed).length / strong.length).toBeGreaterThan(0.95);
  });
});

describe('network planner', () => {
  it('a city of 100 phones catches a nearby M6 within seconds and locates it', () => {
    const s = plan({ confirm: true });
    expect(s.detected).toBe(1);
    expect(s.medianDeclaredS!).toBeLessThan(8);
    expect(s.medianErrKm!).toBeLessThan(10);
    expect(s.warned!).toBeGreaterThan(0.8);
  });

  it('beneath the city the strong shaking outruns most warnings (the blind zone)', () => {
    const under = plan({ distanceKm: [0, 5] });
    const near = plan({ distanceKm: [30, 50] });
    expect(under.medianWarningS!).toBeLessThan(near.medianWarningS!);
    expect(under.warned!).toBeLessThan(near.warned!);
  });

  it('more phones catch more of the quakes that are hard to feel', () => {
    const few = plan({ phones: 10, distanceKm: [60, 150], mag: 5, quakes: 12 }, m5);
    const many = plan({ phones: 100, distanceKm: [60, 150], mag: 5, quakes: 12 }, m5);
    expect(many.detected).toBeGreaterThan(few.detected);
  });

  it('bumped phones do not add up to false alerts', () => {
    expect(plan({ phones: 100, quakes: 16 }).falseAlerts).toBe(0);
  });

  it('is reproducible for the same inputs', () => {
    expect(plan({ phones: 30 })).toEqual(plan({ phones: 30 }));
  });
});
