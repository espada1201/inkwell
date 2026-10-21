import { describe, expect, it } from 'vitest';
import { fetchUsgs, matchUsgs, parseFeed } from '../../src/net/usgs';

const feed = {
  type: 'FeatureCollection',
  features: [
    { id: 'ci1', properties: { mag: 4.2, place: '10 km N of Ridgecrest, CA', time: 1_000_000, url: 'https://x/ci1' }, geometry: { coordinates: [-117.6, 35.7, 8] } },
    { id: 'nc2', properties: { mag: 1.1, place: null, time: 2_000_000, url: 'https://x/nc2' }, geometry: { coordinates: [-122.3, 38.2, 5] } },
    { id: 'bad', properties: { mag: 1, place: 'x', time: null, url: '' }, geometry: null },
  ],
};

describe('USGS feed', () => {
  it('parses features newest first and drops broken ones', () => {
    const q = parseFeed(feed);
    expect(q.map((x) => x.id)).toEqual(['nc2', 'ci1']);
    expect(q[1]).toMatchObject({ lat: 35.7, lon: -117.6, depthKm: 8, mag: 4.2 });
    expect(q[0].place).toBe('Unknown location');
  });

  it('throws on garbage and on HTTP errors', async () => {
    expect(() => parseFeed({})).toThrow();
    const fail = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(fetchUsgs('hour', fail)).rejects.toThrow('503');
  });

  it('matches our event to the nearest official one in space and time', () => {
    const q = parseFeed(feed);
    const m = matchUsgs({ lat: 35.75, lon: -117.62, time: 1_003_000 }, q)!;
    expect(m.quake.id).toBe('ci1');
    expect(m.distanceKm).toBeLessThan(10);
    expect(m.dtS).toBeCloseTo(3);
    expect(matchUsgs({ lat: 35.75, lon: -117.62, time: 1_000_000 + 600_000 }, q)).toBeNull();
    expect(matchUsgs({ lat: 0, lon: 0, time: 1_000_000 }, q)).toBeNull();
  });
});
