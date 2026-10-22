import { generateSecretKey } from 'nostr-tools/pure';
import { signHeartbeat } from '../../src/net/protocol';
import { expect, test } from './fixtures';
import { send } from './publish';

/** Phones that announce right now that they are listening at these spots. */
const listeningAt = (spots: [number, number][]) => spots.map(([lat, lon]) => signHeartbeat(generateSecretKey(), { lat, lon, noise: 0.01, sps: 50 }));

test('planning a network for Kathmandu', async ({ page }) => {
  await page.goto('/#plan/kathmandu/6/near/50');
  await expect(page.getByRole('heading', { name: 'Plan a network' })).toBeVisible();
  await expect(page.locator('[data-city="kathmandu"]')).toHaveAttribute('aria-pressed', 'true');

  // The simulation runs in a worker; the page stays responsive and reports results.
  await expect(page.getByTestId('kpi-detected')).toHaveText(/^\d+\/24$/, { timeout: 30_000 });
  // A busy hour of bumped and jostled phones without a quake.
  await expect(page.getByTestId('kpi-false')).toHaveText(/^0\/60$/);
  await expect(page.locator('.plan-story')).toContainText('With 50 phones listening across Kathmandu');
  // The first alert is timed where people get it: at the phones, a relay hop after the network declares.
  await expect(page.getByTestId('kpi-alert')).toHaveText(/^(\d+\.\d s|—)$/);
  await expect(page.getByTestId('kpis')).toContainText('at the phones, after the rupture');
  // The "how many phones" curve fills in point by point.
  await expect(page.getByTestId('sweep').locator('circle').first()).toBeVisible({ timeout: 30_000 });

  // Changing the quake re-runs the plan and keeps the choice in the address.
  await page.getByRole('button', { name: 'M7' }).click();
  await expect(page).toHaveURL(/#plan\/kathmandu\/7\/near\/50$/);
  await expect(page.locator('.plan-story')).toContainText('M7', { timeout: 30_000 });

  // The phone count is a keyboard-friendly slider.
  const slider = page.getByRole('slider', { name: 'Phones listening' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('output')).toHaveText('75 phones');
  await expect(slider).toHaveAttribute('aria-valuetext', '75 phones');
  await expect(page).toHaveURL(/\/75$/);
  await expect(page.locator('.plan-story')).toContainText('With 75 phones', { timeout: 30_000 });
});

test('planning for Here: the phones listening now beside the number that would catch a quake', async ({ page, relay }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem('tremor.location', JSON.stringify({ lat: 37.8, lon: -122.27 })));
  await page.goto(`/?relays=${relay.url}#plan/kathmandu/6/under/50`);
  await expect(page.getByTestId('relay-status')).toHaveText('1/1 relays');
  await page.locator('[data-city="here"]').click();
  await expect(page.locator('[data-city="here"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#plan\/37\.8,-122\.27\/6\/under\/50$/);
  const gap = page.getByTestId('plan-gap');
  await expect(gap).toHaveText(/^Right now no phones listen within 20 km of you; about \d+ would catch an M6 beneath you 9 times in 10, alerting phones about \d+\.\d s after it begins\. Plan with \d+ phones here$/, { timeout: 60_000 });

  // Three phones start listening nearby and one 60 km away: the plan follows the three.
  await send(relay.url, listeningAt([[37.8, -122.27], [37.85, -122.3], [37.72, -122.2], [38.35, -122.27]]));
  await expect(gap).toContainText('Right now 3 phones listen within 20 km of you; about', { timeout: 60_000 });
  await expect(page.locator('output')).toHaveText('3 phones');
  // Early detection needs four phones, so three never declare a quake.
  await expect(page.locator('.plan-story')).toContainText('With 3 phones listening within 20 km of you, none of the 24 simulated M6 quakes beneath you was detected', { timeout: 60_000 });

  // The target is a link to the same plan with that many phones.
  const link = gap.getByRole('link');
  const href = (await link.getAttribute('href'))!;
  expect(href).toMatch(/^#plan\/37\.8,-122\.27\/6\/under\/\d+$/);
  await link.click();
  await expect(page.locator('output')).toHaveText(`${href.split('/').pop()} phones`);
  expect(new URL(page.url()).hash).toBe(href);
});

test('a planned spot opens from its link without a saved location, and any spot can be typed', async ({ page, relay }) => {
  test.setTimeout(150_000);
  await page.goto(`/?relays=${relay.url}#plan/37.8,-122.27/6/under/25`);
  const here = page.locator('[data-city="here"]');
  await expect(here).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.plan-story')).toContainText('With 25 phones listening within 20 km of 37.80°N 122.27°W', { timeout: 60_000 });
  await expect(page.getByTestId('plan-gap')).toContainText(/^Right now no phones listen within 20 km of 37\.80°N 122\.27°W; about \d+ would catch an M6 beneath 37\.80°N 122\.27°W/, { timeout: 60_000 });

  // Without a saved location, Here asks for coordinates and refuses ones off the globe.
  await page.locator('[data-city="kathmandu"]').click();
  await expect(page.getByTestId('plan-gap')).toBeHidden();
  await here.click();
  const spot = page.getByLabel('Latitude, longitude');
  await expect(spot).toBeFocused();
  await expect(page.getByText('Type coordinates, or save your location under Be a sensor.')).toBeVisible();
  await spot.fill('95, 10');
  await spot.press('Enter');
  await expect(page.getByText('Type a latitude from −90 to 90 and a longitude from −180 to 180')).toBeVisible();
  await expect(here).toHaveAttribute('aria-pressed', 'false');
  await spot.fill('27.7 85.32');
  await page.getByRole('button', { name: 'Plan here' }).click();
  await expect(page).toHaveURL(/#plan\/27\.7,85\.32\/6\/under\/25$/);
  await expect(page.locator('.plan-story')).toContainText('With 25 phones listening within 20 km of 27.70°N 85.32°E', { timeout: 60_000 });
});
