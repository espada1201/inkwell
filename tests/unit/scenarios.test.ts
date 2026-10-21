import { describe, expect, it } from 'vitest';
import { associate, type Trigger } from '../../src/core/associate';
import { distanceKm } from '../../src/core/geo';
import { SCENARIOS, simulate } from '../../src/core/scenarios';

const triggersOf = (sim: ReturnType<typeof simulate>): Trigger[] =>
  sim.nodes.flatMap((n) =>
    n.outputs.filter((o) => o.kind === 'trigger').map((o, k) => ({ id: `${n.id}-${k}`, node: n.id, lat: n.lat, lon: n.lon, t: o.t, pga: o.pga })),
  );

describe('bundled scenarios, end to end through the real detector', () => {
  for (const s of SCENARIOS.filter((x) => x.truth)) {
    it(`${s.title}: one event, near the USGS epicentre`, () => {
      const sim = simulate(s, Date.UTC(2026, 0, 1));
      const evs = associate(triggersOf(sim));
      expect(evs).toHaveLength(1);
      const ev = evs[0];
      expect(distanceKm(ev, s.truth!)).toBeLessThan(15);
      expect(Math.abs(ev.time - sim.origin)).toBeLessThan(3000);
      expect(Math.abs(ev.mag! - s.truth!.mag)).toBeLessThan(1);
    });
  }

  it('concert night: plenty of local rejects, no false earthquake', () => {
    const sim = simulate(SCENARIOS.find((s) => !s.truth)!, Date.UTC(2026, 0, 1));
    const rejects = sim.nodes.flatMap((n) => n.outputs.filter((o) => o.kind === 'reject'));
    expect(rejects.length).toBeGreaterThan(20);
    expect(associate(triggersOf(sim))).toEqual([]);
  });
});
