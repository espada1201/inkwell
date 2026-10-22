import { describe, expect, it } from 'vitest';
import { calibrate, type PhoneModel } from '../../src/core/phonemodel';
import { enoughPhones, simulatePlan, type PlanInput, type PlanResult, type Summary } from '../../src/core/planner';
import { alertS } from '../../src/core/simnet';
import { upperMedian } from '../../src/core/stats';

function runPlan(input: PlanInput, model: PhoneModel): PlanResult {
  const steps = simulatePlan(input, model);
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
  }
}

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
  it('tries every network size on the same quakes, so the sizes compare networks and not luck', () => {
    const quakes = (phones: number) => runPlan({ city, radiusKm: 20, phones, mag: 6, distanceKm: [60, 150], quakes: 6, quietMinutes: 0 }, m6).trials.map((t) => t.epicentre);
    expect(quakes(250)).toEqual(quakes(500));
  });

  it('a city of 100 phones catches a nearby M6 within seconds and locates it', () => {
    const s = plan({ confirm: true });
    expect(s.detected).toBe(1);
    expect(s.medianAlertS!).toBeLessThan(9);
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

  // Was about one an hour: the picks were judged before any of the quiet phones around them was due.
  it('a busy hour of bumps in a dense town raises no false alert', () => {
    for (const seed of [1, 2]) expect(plan({ phones: 300, radiusKm: 5, quakes: 0, quietMinutes: 60, seed })).toMatchObject({ falseAlerts: 0, quietMinutes: 60 });
  });

  it('times the first alert where phones get it: one relay hop after the network declares', () => {
    const { summary, trials } = runPlan({ city, radiusKm: 20, phones: 100, mag: 6, distanceKm: [15, 50], quakes: 8 }, m6);
    const declared = trials.flatMap((t) => (t.declaredS === null ? [] : [t.declaredS]));
    expect(declared.length).toBeGreaterThan(0);
    expect(summary.medianAlertS).toBe(alertS(upperMedian(declared)!));
  });

  it('is reproducible for the same inputs', () => {
    expect(plan({ phones: 30 })).toEqual(plan({ phones: 30 }));
  });
});

describe('the smallest network that catches a quake', () => {
  const point = (phones: number, detected: number): Summary => ({ phones, detected, medianAlertS: null, medianErrKm: null, warned: null, medianWarningS: null, falseAlerts: 0, quietMinutes: 0 });
  const sweep = [10, 25, 50, 100];

  it('is the first step that catches 9 in 10, once every smaller step is in', () => {
    expect(enoughPhones(sweep, [point(10, 0.2)])).toBeUndefined();
    expect(enoughPhones(sweep, [point(50, 1), point(10, 0.2)])).toBeUndefined();
    expect(enoughPhones(sweep, [point(10, 0.2), point(25, 0.9), point(50, 1)])?.phones).toBe(25);
  });

  it('is none when even the largest misses too often', () => {
    expect(enoughPhones(sweep, sweep.map((n) => point(n, 0.5)))).toBeNull();
  });
});
