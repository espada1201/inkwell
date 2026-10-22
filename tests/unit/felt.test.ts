import { describe, expect, it } from 'vitest';
import { clusterFelt, type Felt } from '../../src/core/felt';
import { offset } from '../../src/core/geo';

const at = { lat: 37.8, lon: -122.27 };
const T = Date.parse('2026-10-22T10:00:00Z');
let n = 0;
/** A report by `node`, `eastKm` east of `at`, felt `min` minutes after T. */
const felt = (node: string, eastKm: number, min = 0, lvl = 2): Felt => ({ id: `r${n++}`, node, ...offset(at, eastKm, 0), t: T + min * 60_000, lvl });

describe('felt report clusters', () => {
  it('three people in three places within 30 km and 10 minutes are one shaking, at its median level', () => {
    expect(clusterFelt([felt('a', 0, 0, 2), felt('b', 12, 3, 4), felt('c', 25, 8, 3)])).toEqual([
      expect.objectContaining({ people: 3, places: 3, time: T, lvl: 3, reports: expect.arrayContaining([expect.objectContaining({ node: 'c' })]) }),
    ]);
  });

  it('shows nothing from fewer than three keys or fewer than three places', () => {
    // One key in five places, and three keys in one building.
    expect(clusterFelt([0, 2, 4, 6, 8].map((km) => felt('spam', km)))).toEqual([]);
    expect(clusterFelt(['a', 'b', 'c'].map((k) => felt(k, 0)))).toEqual([]);
  });

  it('counts a key once per ten minutes, its first report, in whatever order the reports arrive', () => {
    const reports = [felt('a', 0, 0, 1), felt('a', 0, 5, 5), felt('b', 12, 1, 3), felt('c', 25, 2, 5)];
    for (const order of [reports, [...reports].reverse()]) {
      expect(clusterFelt(order)).toEqual([expect.objectContaining({ people: 3, places: 3, lvl: 3, time: T })]);
      expect(clusterFelt(order)[0].reports.map((r) => r.node)).toEqual(['a', 'b', 'c']);
    }
    // Ten minutes on, the same key counts again.
    const later = [felt('a', 0, 0), felt('b', 5, 1), felt('c', 10, 2), felt('a', 0, 11), felt('d', 5, 12), felt('e', 10, 13)];
    expect(clusterFelt(later).map((c) => c.reports.map((r) => r.node))).toEqual([
      ['a', 'b', 'c'],
      ['a', 'd', 'e'],
    ]);
  });

  it('every report in a shaking is within 30 km and 10 minutes of its first, so reports cannot be chained', () => {
    expect(clusterFelt([felt('a', 0), felt('b', 20), felt('c', 40)])).toEqual([]);
    expect(clusterFelt([felt('a', 0, 0), felt('b', 5, 6), felt('c', 10, 12)])).toEqual([]);
  });

  it('tells two shakings apart', () => {
    const here = ['a', 'b', 'c'].map((k, i) => felt(k, 5 * i));
    const there = ['d', 'e', 'f'].map((k, i) => felt(k, 200 + 5 * i, 1));
    expect(clusterFelt([...there, ...here]).map((c) => c.reports.map((r) => r.node).sort())).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });
});
