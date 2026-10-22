import { describe, expect, it } from 'vitest';
import { distanceFor, pgaFor } from '../../src/core/physics';

describe('the shaking model', () => {
  it('inverts for the distance at which a quake still shakes the ground this hard', () => {
    for (const m of [3, 5, 7]) for (const r of [5, 40, 200]) expect(distanceFor(m, pgaFor(m, r))).toBeCloseTo(r, 6);
  });
});
