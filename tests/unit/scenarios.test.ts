import { describe, expect, it } from 'vitest';
import { associate, type Trigger } from '../../src/core/associate';
import { distanceKm } from '../../src/core/geo';
import { MIN_REPLAY_MAG, SCENARIOS, parseQuakeLink, quakeLink, simulate } from '../../src/core/scenarios';
import { arrivalsOf } from '../../src/core/simnet';

const triggersOf = (sim: ReturnType<typeof simulate>): Trigger[] =>
  sim.nodes.flatMap((n) => arrivalsOf(n, n.outputs).filter((a) => a.kind === 'trigger').map((a) => a.tr));

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

describe('a link to a replayed quake', () => {
  const q = { id: 'nc75095651', time: Date.UTC(2026, 9, 21, 14, 3, 7, 120), lat: 37.8512, lon: -122.2187, depthKm: 8.13, mag: 4.6 };

  it('names everything the replay needs, and reads back the same quake', () => {
    expect(quakeLink(q)).toBe(`usgs/nc75095651/${q.time}/37.8512/-122.2187/8.13/4.6`);
    expect(parseQuakeLink(quakeLink(q))).toEqual(q);
  });

  it('is refused when cut short, mangled, off the globe, out of time or too weak to replay', () => {
    const link = quakeLink(q);
    const bad = [link.split('/').slice(0, -1).join('/'), link.replace('usgs', 'napa'), link.replace('37.8512', '97.8512'), link.replace('/4.6', '/x'), quakeLink({ ...q, mag: MIN_REPLAY_MAG - 0.5 }), 'usgs//1/2/3/4/5', quakeLink({ ...q, time: 1e20 })];
    for (const path of bad) expect(parseQuakeLink(path), path).toBeNull();
  });
});
