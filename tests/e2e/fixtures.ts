import { test as base, expect } from '@playwright/test';
// @ts-expect-error plain JS test helper
import { startRelay } from '../fake-relay.mjs';

const now = Date.now();

export interface FakeRelay {
  url: string;
  events: () => { kind: number; pubkey: string; content: string; tags: string[][] }[];
  close: () => Promise<void>;
}

/** A small USGS-shaped feed. Extra features can be appended per test. */
export function usgsFeed(extra: { id: string; mag: number; place: string; time: number; lat: number; lon: number; depth?: number }[] = []) {
  const rows = [
    { id: 'us1', mag: 4.6, place: 'Central California', time: now - 20 * 60_000, lat: 36.6, lon: -121.2 },
    { id: 'us2', mag: 5.4, place: 'off the east coast of Honshu, Japan', time: now - 5 * 3600_000, lat: 38.1, lon: 142.3 },
    { id: 'us3', mag: 2.1, place: '5 km NW of The Geysers, CA', time: now - 50 * 60_000, lat: 38.8, lon: -122.8 },
    ...extra,
  ];
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      id: r.id,
      properties: { mag: r.mag, place: r.place, time: r.time, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${r.id}` },
      geometry: { type: 'Point', coordinates: [r.lon, r.lat, r.depth ?? 10] },
    })),
  };
}

/** Blank but valid basemap style, so tests never depend on the internet. */
const blankStyle = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9e4d6' } }] };

export const test = base.extend<{ usgs: ReturnType<typeof usgsFeed>; consoleErrors: string[]; relay: FakeRelay }>({
  usgs: [usgsFeed(), { option: true }],
  // A private in-process Nostr relay per test: public relays are unreachable from CI.
  relay: async ({}, use) => {
    const relay: FakeRelay = await startRelay(0);
    await use(relay);
    await relay.close();
  },
  consoleErrors: [
    async ({ page, usgs }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ json: usgs }));
      await page.route('**/tiles.openfreemap.org/**', (r) => r.fulfill({ json: blankStyle }));
      // Public relays stay out of every test; the private fake relay is plain ws://.
      await page.routeWebSocket(/^wss:\/\//, (ws) => ws.close());
      await use(errors);
      expect(errors, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
