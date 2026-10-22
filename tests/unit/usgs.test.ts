import { describe, expect, it } from 'vitest';
import { fetchUsgs, matchFelt, matchUsgs, parseFeed, type UsgsQuake } from '../../src/net/usgs';

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

describe('the quake someone reports feeling', () => {
  const origin = Date.UTC(2026, 9, 21, 14, 3);
  const here = { lat: 37.8, lon: -122.27 };
  const quake = (id: string, mag: number, lat: number, lon: number, time = origin): UsgsQuake => ({ id, mag, place: id, time, lat, lon, depthKm: 8, url: `https://x/${id}` });
  const near = quake('near', 4.5, 37.87, -122.27);
  const felt = (afterS: number, quakes: UsgsQuake[]) => matchFelt({ ...here, t: origin + afterS * 1000 }, quakes)?.quake.id ?? null;

  it('is found by a report made minutes after it, once USGS has posted it', () => {
    // USGS posts about 2.5 min after a quake in California, 8 elsewhere in the US, 20 abroad.
    for (const min of [2.5, 5, 15]) expect(felt(min * 60, [near]), `${min} min`).toBe('near');
  });

  it('began in the hour before the report, and shook the reporter at least weakly', () => {
    expect(felt(2 * 3600, [near])).toBeNull();
    expect(felt(-60, [near])).toBe('near');
    expect(felt(-300, [near])).toBeNull();
    expect(felt(60, [quake('far', 3, 37.8, -120.45)])).toBeNull();
  });

  it('is the one that shook them hardest, then the latest', () => {
    expect(felt(20 * 60, [quake('bigger', 5, 37.8, -121.36, origin + 18.5 * 60_000), near])).toBe('near');
    expect(felt(15 * 60, [near, quake('later', 4.5, 37.71, -122.27, origin + 10 * 60_000)])).toBe('later');
    expect(felt(20 * 60, [quake('m45', 4.5, 38.16, -122.27), quake('micro', 2.4, 37.818, -122.27, origin + 15 * 60_000)])).toBe('m45');
  });
});
