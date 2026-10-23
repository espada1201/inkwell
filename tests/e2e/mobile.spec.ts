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

test('a one-finger swipe over the map scrolls the page on a phone, as it does everywhere else', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const map = page.getByRole('region', { name: 'Map' });
  await expect(map).toBeVisible();
  await page.waitForFunction(() => document.querySelector('.maplibregl-canvas'));
  const box = (await map.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', { x: box.x + box.width / 2, y: box.y + box.height / 2, yDistance: -400, speed: 1200 });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
});

test('the tabs stay in reach on a phone, however far the page is scrolled, and cover no content', async ({ page, relay }) => {
  await page.goto(`/?relays=${relay.url}#network`);
  const tabs = page.getByRole('navigation', { name: 'Sections' });
  await expect(page.getByRole('heading', { name: 'Live network' })).toBeVisible();
  const reachable = async () => {
    const box = (await tabs.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844 + 0.5);
    await expect(tabs).toBeInViewport({ ratio: 1 });
    return box;
  };
  await reachable();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  const bar = await reachable();
  const last = await page.evaluate(() => {
    const panel = document.querySelector('.panel-inner')!;
    return panel.lastElementChild!.getBoundingClientRect().bottom;
  });
  expect(last).toBeLessThanOrEqual(bar.y + 0.5);
  await page.getByRole('link', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'Old phones as civic infrastructure' })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 400));
  await reachable();
  await expect(tabs.getByRole('link', { name: 'About' })).toHaveAttribute('aria-current', 'page');
});
