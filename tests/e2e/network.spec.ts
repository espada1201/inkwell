import { generateSecretKey } from 'nostr-tools/pure';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { signFelt, signHeartbeat, signPick, signRetraction, signTrigger } from '../../src/net/protocol';
// @ts-expect-error plain JS test helper
import { startRelay } from '../fake-relay.mjs';
import { expect, test, usgsFeed, type FakeRelay } from './fixtures';
import { scenarioEvents, send } from './publish';

const napa = scenarioEvents('napa-2014');
const truth = napa.sim.scenario.truth!;

function pickers(src = { lat: 37.9, lon: -122.3 }) {
  const t0 = Date.now() - 15_000;
  return Array.from({ length: 4 }, (_, i) => {
    const sk = generateSecretKey();
    const at = offset(src, Math.cos(i) * (10 + 4 * i), Math.sin(i) * (10 + 4 * i));
    const hyp = hypocentralKm(distanceKm(src, at));
    const t = t0 + (hyp / VP_KMS) * 1000;
    const pick = signPick(sk, { ...at, t });
    return {
      heartbeat: signHeartbeat(sk, { ...at, noise: 0.01, sps: 50, since: t0 - 600_000 }),
      pick,
      withdraw: (why: string) => signRetraction(sk, pick.id, why),
      trigger: (mag: number) => signTrigger(sk, { ...at, t, pga: pgaFor(mag, hyp), dur: 8 }),
    };
  });
}

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
  await page.addInitScript((at) => localStorage.setItem('tremor.location', JSON.stringify(at)), { lat: truth.lat + 0.05, lon: truth.lon });
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await expect(page.getByTestId('usgs-list').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('no-events')).toBeVisible();

  await send(relay.url, napa.heartbeats);
  await expect(page.getByTestId('stat-nodes')).toHaveText(String(napa.heartbeats.length));
  await expect(page.locator('.stats')).toHaveAttribute('title', /^Phones listening now \(heard from in the last 3 minutes\)/);

  // Raw picks alone: a provisional detection, seconds after the P wave in real life.
  await send(relay.url, napa.picks);
  await expect(page.getByTestId('provisional')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Provisional earthquake detection');
  await expect(page.getByTestId('provisional')).toContainText(/± \d+ km/);
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
  const km = Number((await page.getByTestId('est-km').innerText()).match(/^± (\d+) km/)![1]);
  expect(distanceKm(est, truth)).toBeLessThanOrEqual(km);
  await expect(page.getByTestId('est-mag')).toHaveText(/^M\d\.\d–\d\.\d$/);
  await expect(page.getByTestId('compare')).toContainText('In tests on simulated quakes, nine times in ten');
  await expect(page.getByTestId('compare')).toContainText('which reads big quakes low');
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
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  const near = page.getByTestId('near');
  const items = near.getByTestId('near-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(/USGS: 5 km NW of The Geysers, CA\d+ km from you · rough local shaking: weak/);
  await expect(items.nth(1)).toContainText('USGS: 6 km NW of American Canyon, CA');
  await expect(page.getByTestId('usgs-list')).toContainText('Central California');
  await expect(near).toContainText('Drop, Cover and Hold On');
  await expect(near.getByRole('link', { name: 'leave an old phone on charge with Tremor open' })).toHaveAttribute('href', '#sensor');
  await expect(near).not.toContainText(/official/i);
  const usgs = page.getByTestId('usgs-list').getByRole('button');
  await expect(usgs.first()).toContainText('The Geysers');
  await page.getByRole('button', { name: 'worldwide' }).click();
  await expect(usgs.first()).toContainText('American Canyon');
});

test('without a location the card asks once, by typed coordinates or the browser, and keeps it', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const near = page.getByTestId('near');
  const typed = near.getByLabel('Or type a town, or latitude, longitude');
  await typed.fill('38.7');
  await near.getByRole('button', { name: 'Set' }).click();
  await expect(near.getByRole('status')).toHaveText('Type a town, or a latitude and a longitude with a point for decimals, for example 37.80, -122.27.');
  await expect(typed).toHaveAttribute('aria-invalid', 'true');
  await typed.fill('-33.9249, 18.4241');
  await near.getByRole('button', { name: 'Set' }).click();
  await expect(near).toContainText('Nothing strong enough to feel has been reported near you yet. USGS usually posts within about 2.5 min in California, about 8 min elsewhere in the US and about 20 min abroad.');
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

  await page.evaluate(() => localStorage.setItem('tremor.join', '1'));
  await page.reload();
  await expect(near).toContainText('Near 38.71°N 122.70°W');
  await expect(near.getByRole('button', { name: 'change' })).toHaveCount(0);
  await expect(near.getByRole('link', { name: 'change it under Be a sensor' })).toHaveAttribute('href', '#sensor');
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
  await expect(page.getByTestId('stat-nodes')).toHaveText('3', { timeout: 5000 });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(`${relay.url}\nwss://nos.lol`);
  await expect(page.locator('details.relays')).toHaveAttribute('open');
});

test('with every relay refusing, the panel says nothing can be heard rather than all is quiet', async ({ page }) => {
  await page.goto('/?relays=wss://relay.one.example,wss://relay.two.example#network');
  await expect(page.getByTestId('relay-status')).toHaveText('0/2 relays');
  const down = page.getByRole('status').filter({ hasText: 'Not connected to any relay' });
  await expect(down).toBeVisible();
  await expect(down).toContainText('check your connection or the relay list');
  await expect(page.getByTestId('no-events')).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(down).toBeVisible();
});

test('with no relay and no USGS feed, the near-you card says it cannot tell, not that all is quiet', async ({ page }) => {
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ body: 'garbage' }));
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto('/?relays=wss://relay.one.example#network');
  await expect(page.getByTestId('relay-status')).toHaveText('0/1 relays');
  await expect(page.getByTestId('near')).toContainText('Neither the USGS feed nor any relay can be reached right now');
  await expect(page.getByTestId('near')).not.toContainText('Nothing strong enough to feel');
});

test('a felt report made with no relay connected says it is waiting to go out', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: -33.92, lon: 18.42 })));
  await page.goto('/?relays=wss://relay.one.example#network');
  await expect(page.getByTestId('relay-status')).toHaveText('0/1 relays');
  await page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  const dialog = page.getByRole('dialog', { name: 'I felt it' });
  await dialog.getByRole('button', { name: /^strong/ }).click();
  await expect(dialog.getByRole('status')).toContainText('No relay is connected yet: it goes out once one is, while this page stays open.');
  await expect(dialog.getByRole('link', { name: 'Tell USGS too' })).toHaveAttribute('href', 'https://earthquake.usgs.gov/data/dyfi/');
});

test('a felt report sent from the header reaches the relay, and offers to tell USGS about the quake it matches', async ({ page, relay }) => {
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ json: usgsFeed([{ id: 'nc-felt', mag: 4.2, place: '3 km E of Cobb, CA', time: Date.now() - 6 * 60_000, lat: 38.82, lon: -122.69 }]) }));
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await expect(page.getByTestId('usgs-list')).toContainText('Cobb');
  await page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  const dialog = page.getByRole('dialog', { name: 'I felt it' });
  await expect(dialog.getByRole('group', { name: 'How strong was the shaking where you are?' }).getByRole('button')).toHaveCount(5);
  await dialog.getByRole('button', { name: /^light/ }).click();
  await expect(dialog.getByRole('status')).toContainText('You reported light shaking at');
  const usgs = dialog.getByRole('link', { name: 'Tell USGS too' });
  await expect(usgs).toHaveAttribute('href', 'https://earthquake.usgs.gov/earthquakes/eventpage/nc-felt/tellus');
  await expect(usgs).toBeFocused();
  await expect.poll(() => relay.events().filter((e) => e.kind === 4580).map((e) => JSON.parse(e.content))).toEqual([expect.objectContaining({ v: 1, lat: 38.7, lon: -122.7, lvl: 2 })]);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('near').getByRole('button', { name: 'I felt it' }).click();
  await expect(dialog.getByRole('status')).toContainText('You can report again from');
  await expect(dialog.getByRole('group')).toHaveCount(0);
  expect(relay.events().filter((e) => e.kind === 4580)).toHaveLength(1);
});

test('with site storage blocked, a felt report still says it went out, and reopening finds it', async ({ page, relay }) => {
  // As some private windows do: every touch of localStorage throws.
  await page.addInitScript(() =>
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    }),
  );
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  const dialog = page.getByRole('dialog', { name: 'I felt it' });
  await dialog.getByLabel('Or type a town, or latitude, longitude').fill('38.7, -122.7');
  await dialog.getByRole('button', { name: 'Set' }).click();
  await dialog.getByRole('button', { name: /^light/ }).click();
  await expect(dialog.getByRole('status')).toContainText('You reported light shaking at');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  await expect(dialog.getByRole('status')).toContainText('You can report again from');
  await expect.poll(() => relay.events().filter((e) => e.kind === 4580).length).toBe(1);
});

test('felt reports show once three people in three places agree, and one key spamming shows nothing', async ({ page, relay }) => {
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  const spammer = generateSecretKey();
  const sacramento = { lat: 38.58, lon: -121.49 };
  await send(relay.url, Array.from({ length: 12 }, (_, i) => signFelt(spammer, { ...offset(sacramento, 2 * i, 0), t: Date.now() - i * 20_000, lvl: 5 })));
  const santaRosa = { lat: 38.44, lon: -122.71 };
  await send(relay.url, [0, 4, 8].map((km, i) => signFelt(generateSecretKey(), { ...offset(santaRosa, km, 0), t: Date.now() - i * 60_000, lvl: 3 })));
  const felt = page.getByTestId('felt');
  await expect(felt).toHaveCount(1);
  await expect(felt).toContainText('3 people in 3 places felt shaking, typically moderate');
  await expect(page.getByTestId('near-item').filter({ hasText: 'felt shaking' })).toContainText([/^felt3 people in 3 places felt shaking\d+ km from you · typically moderate/]);
});

test('the opt-in chime sounds once per shaking confirmed near you, never for withdrawn picks or for what people say they felt', async ({ page, relay }) => {
  const here = { lat: 38.3, lon: -122.3 };
  let listed = [{ id: 'before', mag: 4.5, place: 'Before the tap', time: Date.now() - 25 * 60_000, ...offset(here, 30, 0) }];
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ json: usgsFeed(listed) }));
  await page.addInitScript((at) => {
    localStorage.setItem('tremor.location', JSON.stringify(at));
    const w = window as unknown as { chimes: { tones: number; buzzes: number; notes: string[] } };
    w.chimes = { tones: 0, buzzes: 0, notes: [] };
    const node = () => ({ connect: (n: unknown) => n, start: () => w.chimes.tones++, stop() {}, frequency: {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
    window.AudioContext = class {
      currentTime = 0;
      destination = {};
      createOscillator = node;
      createGain = node;
      resume = async () => {};
    } as unknown as typeof AudioContext;
    window.Notification = Object.assign(
      function (_: string, o: NotificationOptions) {
        w.chimes.notes.push(o.body!);
      },
      { permission: 'granted' },
    ) as unknown as typeof Notification;
    navigator.vibrate = () => {
      w.chimes.buzzes++;
      return true;
    };
  }, here);
  const tones = async () => (await page.evaluate(() => (window as unknown as { chimes: { tones: number } }).chimes)).tones;
  const felt = (t: number, lvl: number, from = here) => [0, 4, 8].map((km) => signFelt(generateSecretKey(), { ...offset(from, km, 0), t, lvl }));
  const rows = page.getByTestId('felt');
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await send(relay.url, felt(Date.now() - 28 * 60_000, 3));
  await expect(rows).toHaveCount(1);
  const near = page.getByTestId('near');
  await expect(near).toContainText('Only while Tremor is open: a closed tab cannot alert you.');
  await near.getByLabel('Chime when shaking is confirmed near me').check();

  const south = pickers({ lat: 37.9, lon: -122.3 });
  await send(relay.url, south.map((p) => p.heartbeat));
  await send(relay.url, south.map((p) => p.pick));
  await expect(page.getByTestId('provisional')).toBeVisible();
  expect(await tones()).toBe(0);
  await send(relay.url, south.map((p) => p.withdraw('footsteps')));
  await expect(page.getByTestId('outcome')).toContainText('Not confirmed');
  expect(await tones()).toBe(0);

  const north = pickers({ lat: 38.7, lon: -122.3 });
  await send(relay.url, [...north.map((p) => p.heartbeat), ...north.map((p) => p.trigger(5))]);
  await expect(page.getByTestId('stat-events')).toHaveText('1');
  const note = page.getByRole('alert').filter({ hasText: 'Shaking reported near you. Not an official warning.' });
  await expect(note).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { chimes: object }).chimes)).toEqual({ tones: 1, buzzes: 1, notes: ['Shaking reported near you. Not an official warning.'] });
  await note.getByRole('button', { name: 'Dismiss' }).click();
  await expect(note).toBeHidden();

  await send(relay.url, felt(Date.now(), 3));
  await expect(rows).toHaveCount(2);
  expect(await tones()).toBe(1);
  await send(relay.url, felt(Date.now() - 14 * 60_000, 5, offset(here, 0, 45)));
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('near-item').filter({ hasText: 'typically very strong' })).toBeVisible();
  expect(await tones()).toBe(1);
  listed = [...listed, { id: 'old', mag: 4.5, place: 'Long ago', time: Date.now() - 40 * 60_000, ...offset(here, -30, 0) }];
  await page.getByRole('button', { name: 'past hour' }).click();
  await expect(page.getByTestId('usgs-list')).toContainText('Long ago');
  expect(await tones()).toBe(1);
  listed = [...listed, { id: 'new', mag: 4.5, place: 'Just now', time: Date.now() - 12 * 60_000, ...offset(here, 0, -30) }];
  await page.getByRole('button', { name: 'past day' }).click();
  await expect(note).toBeVisible();
  expect(await tones()).toBe(2);
});

test('the relay editor says why it saved nothing, and which lines were wrong', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await page.locator('details.relays summary').click();
  const box = page.getByLabel('Relay URLs, one per line');
  await box.fill('relay.damus.io\nwss://nos.lol\nnostr.wine\nws://relay.example.com');
  await page.getByRole('button', { name: 'Save and reconnect' }).click();
  const note = page.getByRole('status').filter({ hasText: 'Relay addresses start with wss://' });
  await expect(note).toContainText('relay.damus.io, nostr.wine, ws://relay.example.com');
  await expect(note).not.toContainText('nos.lol');
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => localStorage.getItem('tremor.relays'))).toBeNull();
  await expect(box).toHaveValue('relay.damus.io\nwss://nos.lol\nnostr.wine\nws://relay.example.com');
});

for (const refused of [false, true])
  test(`a saved relay list, one per line or as a link writes it, is the one used after a reload${refused ? ', for this tab where the browser refuses to store it' : ''}`, async ({ page, relay }) => {
    if (refused)
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException('full', 'QuotaExceededError');
        };
      });
    await page.goto(`/?relays=${relay.url}#network`);
    await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
    await page.locator('details.relays summary').click();
    await page.getByLabel('Relay URLs, one per line').fill(`${relay.url}${refused ? '\n' : ','}wss://relay.two.example`);
    await page.getByRole('button', { name: 'Save and reconnect' }).click();
    await expect(page.getByTestId('relay-status')).toHaveText('1/2 relays');
    await page.reload();
    await expect(page.getByTestId('relay-status')).toHaveText('1/2 relays');
    expect(await page.evaluate(() => localStorage.getItem('tremor.relays'))).toBe(refused ? null : JSON.stringify([relay.url, 'wss://relay.two.example']));
  });

test('a relay link with no usable address falls back to the usual relays', async ({ page }) => {
  await page.goto('/?relays=relay.damus.io,ws://relay.example.com#network');
  await page.locator('details.relays summary').click();
  await expect(page.getByLabel('Relay URLs, one per line')).toHaveValue('wss://relay.damus.io\nwss://nos.lol\nwss://relay.primal.net\nwss://offchain.pub');
});

test('the copy claims no more coverage than there is, and says where official alerts come from', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.locator('.lede')).toContainText('wherever someone has set one up');
  await expect(page.locator('.lede')).not.toContainText('everywhere');
  await expect(page.locator('.stats')).toContainText('confirmed reports');
  await expect(page.locator('.honest')).toContainText('on Android, turn on Earthquake alerts in Settings under Safety & emergency (the path varies by maker)');
  await expect(page.locator('.honest')).toContainText('on the US West Coast, keep Wireless Emergency Alerts on and add the MyShake app');
  await expect(page.getByText('Outside the US, USGS may not list quakes below about M4.5.')).toBeVisible();
});

test('USGS outage shows a calm error state', async ({ page, relay }) => {
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ status: 200, body: 'garbage' }));
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByText('The USGS feed could not be reached')).toBeVisible();
  await expect(page.getByTestId('near')).toContainText('Nothing strong enough to feel has been reported near you yet. USGS usually posts within about 2.5 min in California, about 8 min elsewhere in the US and about 20 min abroad. The USGS feed cannot be reached right now, so this is from Tremor alone.');
});

test('without online tiles the map falls back to a bundled coastline', async ({ page, relay, consoleErrors }) => {
  await page.route('**/tiles.openfreemap.org/**', (r) => r.fulfill({ status: 404, json: {} }));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByText('Offline basemap')).toBeVisible();
  // The browser itself logs the failed style request; that one is expected here.
  const rest = consoleErrors.filter((e) => !e.includes('404'));
  consoleErrors.splice(0, consoleErrors.length, ...rest);
});

test('a town typed by name gives distances from it, and picking a quake takes the reader to how it compares', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await send(relay.url, [...napa.heartbeats, ...napa.finals]);
  const near = page.getByTestId('near');
  const typed = near.getByLabel('Or type a town, or latitude, longitude');
  await typed.fill('San Rafael');
  await typed.press('Enter');
  await expect(near.getByRole('status')).toHaveText(/towns match\. Which one\?/);
  // Biggest first, and the keyboard is on the first choice.
  await expect(near.getByRole('button', { name: 'San Rafael, AR' })).toBeFocused();
  await near.getByRole('button', { name: 'San Rafael, CA, US' }).click();
  await expect(near).toContainText('Near San Rafael, CA, US (37.97°N 122.53°W)');
  await near.getByRole('button', { name: 'change' }).click();
  await typed.fill('vallejo');
  await typed.press('Enter');
  await expect(near).toContainText('Near Vallejo, CA, US (38.10°N 122.26°W)');
  await expect(near.getByTestId('near-item').first()).toContainText(/\d+ km from Vallejo, CA, US/);
  expect(await page.evaluate(() => localStorage.getItem('tremor.place'))).toBe('Vallejo, CA, US');

  const row = page.getByTestId('event-list').getByRole('button');
  await expect(row).toContainText('phones agreed · compare ›');
  await row.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByTestId('compare');
  await expect(detail).toBeFocused();
  await expect(detail).toBeInViewport();
  await expect(detail.getByTestId('detail-km')).toHaveText(/^\d+ km from Vallejo, CA, US$/);

  await near.getByRole('button', { name: 'change' }).click();
  await typed.fill('Qqqqzz');
  await typed.press('Enter');
  await expect(near.getByRole('status')).toContainText('No town called “Qqqqzz”');
  await expect(typed).toHaveAttribute('aria-invalid', 'true');
  await typed.fill('38.7, -122.7');
  await typed.press('Enter');
  await expect(near).toContainText('Near 38.70°N 122.70°W');
  await expect(near.getByTestId('near-item').first()).toContainText('km from you');
  expect(await page.evaluate(() => localStorage.getItem('tremor.place'))).toBe('');
});

test('shaking felt a while ago is reported at the time it shook, and a press beside the dialog closes it', async ({ page, relay }) => {
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  const dialog = page.getByRole('dialog', { name: 'I felt it' });
  const when = dialog.getByRole('group', { name: 'When was it?' });
  await expect(when.getByRole('button', { name: 'Just now' })).toHaveAttribute('aria-pressed', 'true');
  await when.getByRole('button', { name: '15 min ago' }).click();
  await expect(when.getByRole('button', { name: '15 min ago' })).toHaveAttribute('aria-pressed', 'true');
  const before = Date.now();
  await dialog.getByRole('button', { name: /^light/ }).click();
  await expect(dialog.getByRole('status')).toContainText('You reported light shaking at');
  await expect(dialog.getByRole('status')).toContainText('public relays');
  await expect.poll(() => relay.events().filter((e) => e.kind === 4580).length).toBe(1);
  const felt = relay.events().find((e) => e.kind === 4580)!;
  expect(Math.abs(JSON.parse(felt.content).t - (before - 15 * 60_000))).toBeLessThan(5_000);
  // Reopened at once, it still says the report went out, though the shaking was a quarter of an hour ago.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  await expect(dialog.getByRole('status')).toContainText('You can report again from');
  // Selecting text and letting go beside the dialog, or pressing its own padding, leaves it open.
  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(5, 400);
  await page.mouse.up();
  await page.mouse.click(box.x + 2, box.y + box.height - 2);
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 400);
  await expect(dialog).toBeHidden();
});

test('a second report about the same shaking is refused, and says so, rather than thanking for the first', async ({ page, relay }) => {
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 38.7, lon: -122.7 })));
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  const open = () => page.getByRole('banner').getByRole('button', { name: 'I felt it' }).click();
  const dialog = page.getByRole('dialog', { name: 'I felt it' });
  await open();
  await dialog.getByRole('button', { name: '30 min ago' }).click();
  await dialog.getByRole('button', { name: /^light/ }).click();
  await expect.poll(() => relay.events().filter((e) => e.kind === 4580).length).toBe(1);
  // Back later, the report from half an hour ago is not "now", so the question is asked again.
  await page.reload();
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await open();
  await dialog.getByRole('button', { name: '30 min ago' }).click();
  await dialog.getByRole('button', { name: /^strong/ }).click();
  await expect(dialog.getByRole('status')).toContainText('You already reported light shaking at');
  await expect(dialog.getByRole('status')).toContainText('this was not sent');
  await page.waitForTimeout(500);
  expect(relay.events().filter((e) => e.kind === 4580)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Just now' }).click();
  await dialog.getByRole('button', { name: /^strong/ }).click();
  await expect(dialog.getByRole('status')).toContainText('You reported strong shaking at');
  await expect.poll(() => relay.events().filter((e) => e.kind === 4580).length).toBe(2);
});

test('a keyboard skips the header and the map, and lands on each screen it opens', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Skip to content' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Skip to content' })).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Live network' })).toBeFocused();
  await page.getByRole('link', { name: 'Be a sensor' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('start')).toBeFocused();
  await page.getByRole('link', { name: 'About' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Old phones as civic infrastructure' })).toBeFocused();
  // The map takes the keyboard too, and shows that it has it.
  await page.getByRole('link', { name: 'Network' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Live network' })).toBeFocused();
  const canvas = page.locator('.maplibregl-canvas');
  await page.locator('.map-legend summary').focus();
  await page.keyboard.press('Tab');
  await expect(canvas).toBeFocused();
  await expect.poll(() => canvas.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  // Its zoom buttons wear the same ring as every other control, not the map library's blue one.
  await page.keyboard.press('Tab');
  const zoom = page.getByRole('button', { name: 'Zoom in' });
  await expect(zoom).toBeFocused();
  const ring = await page.getByRole('button', { name: 'Skip to content' }).evaluate((el) => (el.focus(), getComputedStyle(el).boxShadow));
  await zoom.focus();
  expect(await zoom.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(ring);
});

test('the Set button stands out while the box holds a town that has not been used yet', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const near = page.getByTestId('near');
  const typed = near.getByLabel('Or type a town, or latitude, longitude');
  const set = near.getByRole('button', { name: 'Set', exact: true });
  const filled = () => set.evaluate((el) => el.classList.contains('primary'));
  expect(await filled()).toBe(false);
  await typed.fill('Vallejo');
  expect(await filled()).toBe(true);
  await typed.fill('   ');
  expect(await filled()).toBe(false);
  await typed.fill('Qqqqzz');
  await set.click();
  await expect(near.getByRole('status')).toContainText('No town called');
  // Refused, so still unused.
  expect(await filled()).toBe(true);
  await typed.fill('Vallejo');
  await set.click();
  await expect(near).toContainText('Near Vallejo, CA, US');
});

test('the key opens beside the map and folds away once the map is used, unless the reader chose', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const key = page.locator('details.map-legend');
  const map = page.getByRole('region', { name: 'Map' });
  await expect(key).toHaveAttribute('open', '');
  await expect(key.getByText('Tremor detection')).toBeVisible();
  const box = (await map.boundingBox())!;
  // Dragging the map clears the key off it.
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await expect(key).not.toHaveAttribute('open');
  await expect(key.locator('summary')).toBeVisible();
  // Opened by the reader, it stays open while the map is used.
  await key.locator('summary').click();
  await expect(key).toHaveAttribute('open', '');
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
  await expect(key).toHaveAttribute('open', '');
});
