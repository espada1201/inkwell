import { distanceKm } from '../../src/core/geo';
// @ts-expect-error plain JS test helper
import { startRelay } from '../fake-relay.mjs';
import { expect, test, usgsFeed, type FakeRelay } from './fixtures';
import { scenarioEvents, send } from './publish';

const napa = scenarioEvents('napa-2014');
const truth = napa.sim.scenario.truth!;

// The official feed "already knows" about this quake, so the app can cross-check itself.
test.use({ usgs: usgsFeed([{ id: 'nc-replayed', mag: truth.mag, place: '6 km NW of American Canyon, CA', time: napa.sim.origin, lat: truth.lat, lon: truth.lon, depth: truth.depthKm }]) });

test('phones on a relay become a detected, USGS-verified earthquake', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await expect(page.getByTestId('usgs-list').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('no-events')).toBeVisible();

  await send(relay.url, napa.heartbeats);
  await expect(page.getByTestId('stat-nodes')).toHaveText(String(napa.heartbeats.length));

  // Raw picks alone: a provisional detection, seconds after the P wave in real life.
  await send(relay.url, napa.picks);
  await expect(page.getByTestId('provisional')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Provisional earthquake detection');

  // Vetted triggers and retractions: a confirmed, located event.
  await send(relay.url, napa.finals);
  await expect(page.getByTestId('stat-events')).toHaveText('1');
  await expect(page.getByTestId('provisional')).toHaveCount(0);
  await expect(page.getByTestId('event-list')).toContainText('Matches USGS');

  await page.getByTestId('event-list').getByRole('button').first().click();
  const loc = page.getByTestId('est-loc');
  const est = { lat: Number(await loc.getAttribute('data-lat')), lon: Number(await loc.getAttribute('data-lon')) };
  expect(distanceKm(est, truth)).toBeLessThan(15);
  await expect(page.getByTestId('verdict')).toContainText('Off by');
});

test('a hostile relay cannot inject forged or malformed events', async ({ page }) => {
  // Broken shapes go straight to the page, unchecked by the relay; none may throw.
  const hb = napa.heartbeats[3];
  const hostile: FakeRelay = await startRelay(0, { verify: false, junk: [{ ...hb, tags: [null] }, { ...hb, tags: 'tremor' }, { ...hb, tags: undefined }] });
  try {
    await page.goto(`/?relays=${hostile.url}#network`);
    await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
    const forged = { ...napa.heartbeats[0], content: napa.heartbeats[0].content.replace(/"lat":[-\d.]+/, '"lat":12.34') };
    const junk = { ...napa.heartbeats[2], kind: 34579, content: '{"v":1,"lat":"x"}', sig: '00'.repeat(64) };
    await send(hostile.url, [forged, junk, napa.heartbeats[1]]);
    await expect(page.getByTestId('stat-nodes')).toHaveText('1');
  } finally {
    await hostile.close();
  }
});

test('keyboard focus stays put while live updates stream in', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  const day = page.getByRole('button', { name: 'past day' });
  await day.focus();
  // A part of the panel whose content did not change is left in place, not rebuilt and read out again.
  await page.getByTestId('no-events').evaluate((el) => (el.dataset.mark = 'kept'));
  await send(relay.url, napa.heartbeats.slice(0, 3));
  await expect(page.getByTestId('stat-nodes')).toHaveText('3');
  await expect(day).toBeFocused();
  await expect(page.getByTestId('no-events')).toHaveAttribute('data-mark', 'kept');
});

test('typing in the relay list neither freezes the panel nor loses what is typed', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await page.locator('details.relays summary').click();
  const box = page.getByLabel('Relay URLs, one per line');
  await box.fill(`${relay.url}\nwss://nos.lol`);
  await send(relay.url, napa.heartbeats.slice(0, 3));
  // Well before the panel's 15 s refresh, which is all a frozen panel would show.
  await expect(page.getByTestId('stat-nodes')).toHaveText('3', { timeout: 5000 });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(`${relay.url}\nwss://nos.lol`);
  await expect(page.locator('details.relays')).toHaveAttribute('open');
});

test('USGS outage shows a calm error state', async ({ page, relay }) => {
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ status: 200, body: 'garbage' }));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByText('The USGS feed could not be reached')).toBeVisible();
});

test('without online tiles the map falls back to a bundled coastline', async ({ page, relay, consoleErrors }) => {
  await page.route('**/tiles.openfreemap.org/**', (r) => r.fulfill({ status: 404, json: {} }));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByText('Offline basemap')).toBeVisible();
  // The browser itself logs the failed style request; that one is expected here.
  const rest = consoleErrors.filter((e) => !e.includes('404'));
  consoleErrors.splice(0, consoleErrors.length, ...rest);
});
