import { expect, test } from './fixtures';

/** Visible elements that stick out past the right edge of the screen (sideways scrolling). */
const overflowing = () =>
  [...document.querySelectorAll<HTMLElement>('body *')]
    .filter((el) => !el.closest('.maplibregl-canvas-container, .maplibregl-marker') && el.getClientRects().length)
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);

for (const [view, ready] of [
  ['network', 'Live network'],
  ['replay/napa-2014', 'Replay'],
  ['plan/kathmandu/6/near/20', 'Plan a network'],
  ['sensor', 'Ready'],
  ['about', 'Old phones as civic infrastructure'],
] as const) {
  test(`#${view} fits a 390 px phone`, async ({ page, relay }) => {
    await page.goto(`/?relays=${relay.url}&speed=10#${view}`);
    await expect(page.getByRole('heading', { name: ready })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    if (view.startsWith('replay')) await expect(page.getByTestId('warned')).toBeVisible();
    if (view.startsWith('plan')) await expect(page.getByTestId('kpi-detected')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(overflowing)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test('the map and its key stay usable on a phone', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const map = page.getByRole('region', { name: 'Map' });
  await expect(map).toBeVisible();
  expect((await map.boundingBox())!.height).toBeGreaterThan(200);
  // The key starts folded so it does not cover the map, and opens on tap.
  const key = page.locator('details.map-legend');
  await expect(key).not.toHaveAttribute('open');
  await key.locator('summary').click();
  await expect(key.getByText('Tremor detection')).toBeVisible();
});
