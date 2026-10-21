import { distanceKm } from '../../src/core/geo';
import { SCENARIOS } from '../../src/core/scenarios';
import { expect, test } from './fixtures';

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
  await expect(page.getByTestId('replay-stats')).toContainText('false alarms caught on-device');
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
  await expect(page.getByTestId('compare')).toBeVisible();
});
