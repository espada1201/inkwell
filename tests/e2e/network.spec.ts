import { generateSecretKey } from 'nostr-tools/pure';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm } from '../../src/core/physics';
import { signHeartbeat, signPick, signRetraction } from '../../src/net/protocol';
// @ts-expect-error plain JS test helper
import { startRelay } from '../fake-relay.mjs';
import { expect, test, usgsFeed, type FakeRelay } from './fixtures';
import { scenarioEvents, send } from './publish';

const napa = scenarioEvents('napa-2014');
const truth = napa.sim.scenario.truth!;

/** Four listening phones around one spot that each picked its P wave 15 s ago, and can withdraw that pick. */
function pickers() {
  const src = { lat: 37.9, lon: -122.3 };
  const t0 = Date.now() - 15_000;
  return Array.from({ length: 4 }, (_, i) => {
    const sk = generateSecretKey();
    const at = offset(src, Math.cos(i) * (10 + 4 * i), Math.sin(i) * (10 + 4 * i));
    const pick = signPick(sk, { ...at, t: t0 + (hypocentralKm(distanceKm(src, at)) / VP_KMS) * 1000 });
    return { heartbeat: signHeartbeat(sk, { ...at, noise: 0.01, sps: 50, since: t0 - 600_000 }), pick, withdraw: (why: string) => signRetraction(sk, pick.id, why) };
  });
}

/** Contrast ratio of an element's text against the background of the row button it sits in. */
function contrastOnRow(el: Element) {
  const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const lum = (c: string) => {
    const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(getComputedStyle(el).color), lum(getComputedStyle(el.closest('.row')!).backgroundColor)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// The official feed "already knows" about this quake, so the app can cross-check itself.
test.use({ usgs: usgsFeed([{ id: 'nc-replayed', mag: truth.mag, place: '6 km NW of American Canyon, CA', time: napa.sim.origin, lat: truth.lat, lon: truth.lon, depth: truth.depthKm }]) });

test('phones on a relay become a detected, USGS-verified earthquake', async ({ page, relay }) => {
  // Someone a few kilometres from the epicentre, whose location the sensor screen saved.
  await page.addInitScript((at) => localStorage.setItem('tremor.location', JSON.stringify(at)), { lat: truth.lat + 0.05, lon: truth.lon });
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await expect(page.getByTestId('usgs-list').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('no-events')).toBeVisible();

  await send(relay.url, napa.heartbeats);
  await expect(page.getByTestId('stat-nodes')).toHaveText(String(napa.heartbeats.length));
  // A phone silent for three minutes is offline, and the explanation says so.
  await expect(page.locator('.stats')).toHaveAttribute('title', /^Phones listening now \(heard from in the last 3 minutes\)/);

  // Raw picks alone: a provisional detection, seconds after the P wave in real life.
  await send(relay.url, napa.picks);
  await expect(page.getByTestId('provisional')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Provisional earthquake detection');
  await expect(page.getByTestId('no-events')).toHaveText('No confirmed detections yet.');
  const ours = page.getByTestId('near-item').filter({ hasText: 'Tremor detection' });
  await expect(ours).toContainText(['Provisional Tremor detection']);

  // Vetted triggers and retractions: a confirmed, located event.
  await send(relay.url, napa.finals);
  await expect(page.getByTestId('stat-events')).toHaveText('1');
  await expect(page.getByTestId('provisional')).toHaveCount(0);
  await expect(page.getByTestId('event-list')).toContainText('Matches USGS');
  await expect(ours).toHaveCount(1);
  await expect(ours).toContainText(/^[\d.]+Tremor detection\d+ km from you · rough local shaking: \w/);
  // The provisional detection stays listed with how it ended, and the announcer says so too.
  await expect(page.getByTestId('outcome')).toHaveCount(1);
  await expect(page.getByTestId('outcome')).toContainText(/^Confirmed: M\d\.\d, matches USGS/);
  await expect(page.getByRole('alert')).toContainText(/Confirmed: M\d\.\d, matches USGS/);

  const row = page.getByTestId('event-list').getByRole('button').first();
  await row.click();
  // The selected row's grey text stays readable on its tinted background (WCAG AA, 4.5:1).
  for (const grey of [row.locator('.when'), row.locator('.muted')]) expect(await grey.evaluate(contrastOnRow)).toBeGreaterThanOrEqual(4.5);
  const loc = page.getByTestId('est-loc');
  const est = { lat: Number(await loc.getAttribute('data-lat')), lon: Number(await loc.getAttribute('data-lon')) };
  expect(distanceKm(est, truth)).toBeLessThan(15);
  await expect(page.getByTestId('verdict')).toContainText('Off by');
});

test('a provisional detection its phones withdraw stays listed as not confirmed, with their reasons', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  const phones = pickers();
  await send(relay.url, phones.map((p) => p.heartbeat));
  await send(relay.url, phones.map((p) => p.pick));
  await expect(page.getByTestId('provisional')).toBeVisible();
  await send(relay.url, phones.map((p, i) => p.withdraw(i < 3 ? 'footsteps' : 'impulse')));
  await expect(page.getByTestId('provisional')).toHaveCount(0);
  await expect(page.getByTestId('outcome')).toContainText(/^Not confirmed: 4 of 4 phones withdrew \(footsteps, bump or door slam\) at \d{1,2}:\d\d/);
  await expect(page.getByRole('alert')).toContainText('Not confirmed: ');
  await expect(page.getByTestId('no-events')).toContainText('No network detections in the past 2 hours');
});

test('shaking near you lists what was reported nearest first, with safety advice after a felt one', async ({ page, relay }) => {
  // Near The Geysers, about 60 km from the replayed Napa quake and 270 km from the one in Central California.
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  const near = page.getByTestId('near');
  const items = near.getByTestId('near-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText(/USGS: 5 km NW of The Geysers, CA\d+ km from you · rough local shaking: \w/);
  await expect(items.nth(1)).toContainText('USGS: 6 km NW of American Canyon, CA');
  await expect(items.nth(2)).toContainText('USGS: Central California');
  await expect(near).toContainText('Drop, Cover and Hold On');
  await expect(near.getByRole('link', { name: 'leave an old phone on charge with Tremor open' })).toHaveAttribute('href', '#sensor');
  await expect(near).not.toContainText(/official/i);
  // The USGS list is nearest first too, until asked for the whole world.
  const usgs = page.getByTestId('usgs-list').getByRole('button');
  await expect(usgs.first()).toContainText('The Geysers');
  await page.getByRole('button', { name: 'worldwide' }).click();
  await expect(usgs.first()).toContainText('American Canyon');
});

test('without a location the card asks once, by typed coordinates or the browser, and keeps it', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const near = page.getByTestId('near');
  const typed = near.getByLabel('Or type latitude, longitude');
  await typed.fill('38.7');
  await near.getByRole('button', { name: 'Set' }).click();
  await expect(near.getByRole('status')).toHaveText('Type a latitude and a longitude, for example 37.80, -122.27.');
  await expect(typed).toHaveAttribute('aria-invalid', 'true');
  // Cape Town: far from every quake in the feed.
  await typed.fill('-33.9249, 18.4241');
  await near.getByRole('button', { name: 'Set' }).click();
  await expect(near).toContainText('Nothing reported near you yet. USGS usually posts within about 2.5 min in California, about 8 min elsewhere in the US and about 20 min abroad.');
  await expect(near).toContainText('Near 33.92°S 18.42°E');
  await expect(near).not.toContainText('Drop, Cover');
  await expect(near.getByRole('button', { name: 'change' })).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tremor.location')!))).toEqual({ lat: -33.92, lon: 18.42 });

  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 38.7123, longitude: -122.6987 });
  await near.getByRole('button', { name: 'change' }).click();
  const locate = near.getByRole('button', { name: 'Use my approximate location' });
  await expect(locate).toBeFocused();
  await locate.click();
  await expect(near.getByTestId('near-item').first()).toContainText('The Geysers');
  await page.reload();
  await expect(near).toContainText('Near 38.71°N 122.70°W');
  await expect(near.getByTestId('near-item').first()).toContainText('The Geysers');
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
  // The panel catches up with the header on its next frame: mark the part once it says the relay is open.
  await expect(page.getByTestId('no-events')).toContainText('No network detections');
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

test('with every relay refusing, the panel says nothing can be heard rather than all is quiet', async ({ page }) => {
  // The fixture closes every wss:// connection at once, as an unreachable relay would.
  await page.goto('/?relays=wss://relay.one.example,wss://relay.two.example#network');
  await expect(page.getByTestId('relay-status')).toHaveText('0/2 relays');
  const down = page.getByRole('status').filter({ hasText: 'Not connected to any relay' });
  await expect(down).toBeVisible();
  await expect(down).toContainText('check your connection or the relay list');
  await expect(page.getByTestId('no-events')).toHaveCount(0);
  // It stays put while the relays are retried (after 1, 2, 4… s).
  await page.waitForTimeout(2500);
  await expect(down).toBeVisible();
});

test('the relay editor says why it saved nothing, and which lines were wrong', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await page.locator('details.relays summary').click();
  const box = page.getByLabel('Relay URLs, one per line');
  await box.fill('relay.damus.io\nwss://nos.lol\nnostr.wine');
  await page.getByRole('button', { name: 'Save and reconnect' }).click();
  const note = page.getByRole('status').filter({ hasText: 'Relay addresses start with wss://' });
  await expect(note).toContainText('relay.damus.io, nostr.wine');
  await expect(note).not.toContainText('nos.lol');
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  // Nothing was saved and the page did not reload under the user.
  expect(await page.evaluate(() => localStorage.getItem('tremor.relays'))).toBeNull();
  await expect(box).toHaveValue('relay.damus.io\nwss://nos.lol\nnostr.wine');
});

test('USGS outage shows a calm error state', async ({ page, relay }) => {
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ status: 200, body: 'garbage' }));
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByText('The USGS feed could not be reached')).toBeVisible();
  // Nothing near you, but only Tremor could be asked.
  await expect(page.getByTestId('near')).toContainText('Nothing reported near you yet. USGS usually posts within about 2.5 min in California, about 8 min elsewhere in the US and about 20 min abroad. The USGS feed cannot be reached right now, so this is from Tremor alone.');
});

test('without online tiles the map falls back to a bundled coastline', async ({ page, relay, consoleErrors }) => {
  await page.route('**/tiles.openfreemap.org/**', (r) => r.fulfill({ status: 404, json: {} }));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByText('Offline basemap')).toBeVisible();
  // The browser itself logs the failed style request; that one is expected here.
  const rest = consoleErrors.filter((e) => !e.includes('404'));
  consoleErrors.splice(0, consoleErrors.length, ...rest);
});
