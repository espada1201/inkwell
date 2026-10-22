import { distanceKm } from '../../src/core/geo';
import { SCENARIOS } from '../../src/core/scenarios';
import { expect, test, usgsFeed } from './fixtures';

test('Napa replay: phones declare early, locate near USGS, and show warning time', async ({ page }) => {
  await page.goto('/?speed=10#replay/napa-2014');
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible();
  await expect(page.locator('[data-scenario="napa-2014"]')).toHaveAttribute('aria-pressed', 'true');

  // Early declaration from raw picks, then the warning analysis
  await expect(page.getByTestId('warned')).toBeVisible();
  await expect(page.locator('.timeline li.done')).toHaveCount(4, { timeout: 30_000 });

  // Confirmed location vs the USGS catalogue
  const loc = page.getByTestId('est-loc');
  await expect(loc).toBeVisible();
  const truth = SCENARIOS.find((s) => s.id === 'napa-2014')!.truth!;
  const est = { lat: Number(await loc.getAttribute('data-lat')), lon: Number(await loc.getAttribute('data-lon')) };
  expect(distanceKm(est, truth)).toBeLessThan(15);
  await expect(page.getByTestId('verdict')).toContainText('Off by');
  const km = Number((await page.getByTestId('est-km').innerText()).match(/^± (\d+) km/)![1]);
  expect(distanceKm(est, truth)).toBeLessThanOrEqual(km);
  await expect(page.getByTestId('est-mag')).toHaveText(/^M\d\.\d–\d\.\d$/);

  const [warned, felt] = (await page.getByTestId('warned').innerText()).split('/').map(Number);
  expect(felt).toBeGreaterThan(10);
  expect(warned / felt).toBeGreaterThan(0.5);
  await expect(page.locator('canvas.section')).toBeVisible();
});

test('concert night: no earthquake is declared', async ({ page }) => {
  await page.goto('/?speed=10#replay/stadium-night');
  await expect(page.locator('[data-scenario="stadium-night"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('play')).toHaveText('Replay', { timeout: 30_000 });
  await expect(page.getByTestId('warning')).toContainText('No alert');
  await expect(page.getByTestId('compare')).toHaveCount(0);
  await expect(page.getByTestId('replay-status')).toHaveText('Replay finished: no quake declared.');
  const stats = await page.getByTestId('replay-stats').innerText();
  expect(stats).toMatch(/^40 simulated phones · \d+ confirmed · \d+ picks withdrawn on-device \((footsteps|bump or door slam|phone moved) \d+(, (footsteps|bump or door slam|phone moved) \d+)*\)$/);
  const confirmed = Number(stats.match(/(\d+) confirmed/)![1]);
  const card = page.getByTestId('warning');
  if (confirmed) await expect(card).toContainText(`${confirmed} more passed`);
  else await expect(card).not.toContainText('passed');
  await expect(page.getByTestId('clock')).toHaveText('1:20');
  await expect(page.getByRole('slider', { name: 'Replay position' })).toHaveAttribute('aria-valuetext', '80 seconds into the replay');
  await expect(page.locator('.timeline li.done .when').first()).toHaveText(/^\d:\d\d$/);
});

function recordAnnouncements() {
  const said: string[] = [];
  Object.assign(window, { said });
  new MutationObserver((records) => {
    const regions = new Set<Element>();
    for (const m of records) {
      const el = m.target instanceof Element ? m.target : m.target.parentElement;
      const region = el?.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]');
      if (region) regions.add(region);
    }
    for (const r of regions) said.push(r.textContent?.trim() ?? '');
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

test('screen readers hear the milestones of a replay, not every second of it', async ({ page }) => {
  await page.addInitScript(recordAnnouncements);
  await page.goto('/?speed=10#replay/napa-2014');
  await expect(page.getByTestId('play')).toHaveText('Replay', { timeout: 30_000 });
  const said = (await page.evaluate(() => (window as unknown as { said: string[] }).said)).filter(Boolean);
  expect(said).toHaveLength(3);
  expect(said[0]).toMatch(/^Network declares a quake at T\+\d+\.\d s\.$/);
  expect(said[1]).toMatch(/^Confirmed at T\+\d+\.\d s\.$/);
  expect(said[2]).toMatch(/^Replay finished: declared at T\+\d+\.\d s, confirmed at T\+\d+\.\d s\.$/);
});

test('switching scenarios and scrubbing works with the keyboard', async ({ page }) => {
  await page.goto('/?speed=10#replay/napa-2014');
  await page.locator('[data-scenario="christchurch-2011"]').click();
  await expect(page).toHaveURL(/#replay\/christchurch-2011/);
  await page.getByTestId('play').click(); // pause
  const scrub = page.getByRole('slider', { name: 'Replay position' });
  await scrub.focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('clock')).toHaveText(/T\+55\.0 s/);
  await expect(scrub).toHaveAttribute('aria-valuetext', '55 seconds after the quake began');
  await expect(page.getByTestId('compare')).toBeVisible();
});

const berkeley = { id: 'nc-berkeley', mag: 5.1, place: '4 km SE of Berkeley, CA', time: Date.now() - 30 * 60_000, lat: 37.85, lon: -122.22, depth: 8 };
const berkeleyLink = `usgs/nc-berkeley/${berkeley.time}/37.85/-122.22/8/5.1`;

test.describe('recent quakes from the USGS feed', () => {
  test.use({ usgs: usgsFeed([berkeley]) });

  test('a recent quake replays with simulated phones, and its link works once it has left the feed', async ({ page }) => {
    await page.goto('/?speed=10#replay/napa-2014');
    const rows = page.getByTestId('recent').locator('li');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('M5.1');
    await rows.nth(1).getByRole('button', { name: 'Replay with simulated phones: M5.1, 4 km SE of Berkeley, CA' }).click();
    expect(new URL(page.url()).hash).toBe(`#replay/${berkeleyLink}`);
    await expect(rows.nth(1).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-scenario="napa-2014"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(/^M5\.1, 4 km SE of Berkeley, CA, .* UTC, from the USGS feed\. The quake is real; the phones are simulated, around the epicentre\./)).toBeVisible();
    await expect(page.getByText('Each line is a phone, and farther phones are lower; the slanted bands are the P and S waves arriving.')).toBeVisible();
    await expect(page.getByTestId('play')).toHaveText('Replay', { timeout: 30_000 });
    await expect(page.getByTestId('replay-stats')).toHaveText(/^40 simulated phones · /);

    await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ json: usgsFeed() }));
    await page.evaluate(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 37.8, lon: -122.27 })));
    await page.goto('about:blank');
    await page.goto(`/?speed=10#replay/${berkeleyLink}`);
    await expect(page.getByText(/^M5\.1, 37\.85°N 122\.22°W, .* UTC, from the USGS feed\. The quake is real; the phones are simulated, around your saved location\./)).toBeVisible();
    await expect(page.getByTestId('recent').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('play')).toHaveText('Replay', { timeout: 30_000 });
    await expect(page.getByTestId('replay-stats')).toHaveText(/^40 simulated phones · /);
  });
});

test('a quake 140 km from the saved location plays on until the phones there have checked its S wave', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 37.85, lon: -120.63 })));
  await page.goto(`/?speed=10#replay/usgs/nc-far/${Date.UTC(2026, 9, 1, 12)}/37.85/-122.22/8/6.8`);
  await expect(page.getByText(/The quake is real; the phones are simulated, around your saved location\./)).toBeVisible();
  await expect(page.getByTestId('play')).toHaveText('Replay', { timeout: 30_000 });
  const clock = page.getByTestId('clock');
  const end = Number((await clock.innerText()).match(/^T\+(\d+)\.0 s$/)![1]);
  expect(end).toBeGreaterThan(55);
  await expect(page.locator('.timeline li.done')).toHaveCount(4);
  await expect(page.getByTestId('replay-status')).toHaveText(/^Replay finished: declared at T\+\d+\.\d s, confirmed at T\+\d+\.\d s\.$/);
  const scrub = page.getByRole('slider', { name: 'Replay position' });
  await scrub.focus();
  await page.keyboard.press('Home');
  await expect(clock).toHaveText('T−25.0 s');
  await page.keyboard.press('End');
  await expect(clock).toHaveText(`T+${end}.0 s`);
  await expect(scrub).toHaveAttribute('aria-valuetext', `${end} seconds after the quake began`);
});

test('a replay link cut short plays the first quake and says why', async ({ page }) => {
  await page.goto(`/?speed=10#replay/${berkeleyLink.split('/').slice(0, 4).join('/')}`);
  await expect(page.locator('[data-scenario="napa-2014"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('That replay link is incomplete or out of range, so South Napa M6.0 plays instead.')).toBeVisible();
});

test('the recent list says when the feed is unreachable, or has nothing phones could feel', async ({ page }) => {
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ status: 200, body: 'garbage' }));
  await page.goto('/?speed=10#replay/napa-2014');
  await expect(page.getByTestId('recent')).toHaveText('The USGS feed could not be reached, so there are no recent quakes to offer. The quakes above always replay.');
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) => r.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await page.reload();
  await expect(page.getByTestId('recent')).toHaveText('No quake of M4 or more in the USGS feed for the past day: phones would barely feel smaller ones.');
});

test('a replay carries on after a visit to another tab, and follows an address edited in place', async ({ page }) => {
  await page.goto('/#replay/christchurch-2011');
  await expect(page.locator('[data-scenario="christchurch-2011"]')).toHaveAttribute('aria-pressed', 'true');
  const tabs = page.getByRole('navigation', { name: 'Sections' });
  await tabs.getByRole('link', { name: 'About' }).click();
  await tabs.getByRole('link', { name: 'Replay' }).click();
  await expect(page.locator('[data-scenario="christchurch-2011"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#replay\/christchurch-2011$/);
  await page.evaluate(() => (location.hash = '#replay/ridgecrest-2019?speed=10'));
  await expect(page.locator('[data-scenario="ridgecrest-2019"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/link is incomplete/)).toHaveCount(0);
});
