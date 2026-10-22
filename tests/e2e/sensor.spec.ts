import { generateSecretKey } from 'nostr-tools/pure';
import { synthesize } from '../../src/core/synth';
import { signHeartbeat } from '../../src/net/protocol';
import { expect, test } from './fixtures';
import { send } from './publish';

async function feed(page: import('@playwright/test').Page, record: { x: number; y: number; z: number }[]) {
  return page.evaluate((rec) => {
    const start = Date.now();
    const t0 = performance.now();
    let i = 0;
    const tick = () => {
      const due = Math.min(rec.length, Math.floor((performance.now() - t0) / 20));
      for (; i < due; i++) {
        const { x, y, z } = rec[i];
        window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x, y, z }, interval: 20 }));
      }
      if (i < rec.length) setTimeout(tick, 10);
    };
    tick();
    return start;
  }, record);
}

test.describe('be a sensor', () => {
  test.beforeEach(async ({ page }) => {
    // Behave like iOS Safari, which only grants motion access through an explicit prompt.
    await page.addInitScript(() => {
      (DeviceMotionEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission = async () => 'granted';
    });
  });

  test('a phone on a table publishes a pick, then a confirmed trigger', async ({ page, relay }) => {
    test.setTimeout(120_000);
    await page.goto(`/?relays=${relay.url}#sensor`);
    await expect(page.getByTestId('sensor-state')).toHaveText('Ready');
    await expect(page.getByTestId('publish-note')).toContainText('Nothing leaves this phone');

    await page.getByLabel('Latitude').fill('37,77493');
    await page.getByLabel('Longitude').fill('-122,41942');
    await page.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'with a point for decimals' })).toBeVisible();
    await expect(page.getByTestId('loc')).toHaveText('Not set');

    await page.getByLabel('Latitude').fill('37.77493');
    await page.getByLabel('Longitude').fill('-122.41942');
    await page.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByTestId('loc')).toHaveText('37.77°N 122.42°W');
    await page.getByLabel('Share with the Tremor network').check();
    await expect(page.getByTestId('publish-note')).toContainText('On.');

    await page.getByTestId('start').click();
    const start = await feed(page, synthesize({ start: 0, durationS: 34, seed: 3, quake: { tP: 10, tS: 13, pga: 0.8 } }));
    await expect(page.getByTestId('sensor-state')).toHaveText('Listening', { timeout: 10_000 });
    await expect(page.getByTestId('background')).toHaveText(/^1[0-5]\.\d mm\/s²$/);
    await expect(page.getByTestId('meter-word')).toHaveText('Quiet');

    await expect.poll(() => relay.events().filter((e) => e.kind === 4578).length, { timeout: 20_000 }).toBe(1);
    const onset = JSON.parse(relay.events().find((e) => e.kind === 4578)!.content).t - (start + 10_000);
    expect(onset).toBeGreaterThan(0);
    expect(onset).toBeLessThan(1000);
    await expect(page.getByTestId('meter-word')).toHaveText('Shaking');
    await expect(page.getByTestId('sensor-log')).toContainText(/Confirmed shaking: (light|moderate|strong), [\d.]+ m\/s² · P wave · sent/, { timeout: 40_000 });
    const verdict = Date.now() - (start + 10_000 + onset);
    expect(verdict).toBeGreaterThan(15_000);
    expect(verdict).toBeLessThan(31_000);
    const events = relay.events();
    const pick = events.find((e) => e.kind === 4578)!;
    const trigger = events.find((e) => e.kind === 4579)!;
    expect(trigger.tags).toContainEqual(['e', (pick as unknown as { id: string }).id]);
    const heartbeat = events.find((e) => e.kind === 34579)!;
    // Only the 1 km grid cell ever leaves the phone.
    expect(JSON.parse(heartbeat.content)).toMatchObject({ lat: 37.77, lon: -122.42, sps: 50 });
    expect(JSON.parse(trigger.content).pga).toBeGreaterThan(0.3);
    // The phone lay flat and the quake's first wave shook it up and down: a P wave.
    expect(JSON.parse(pick.content).ph).toBe('P');

    // The live trace is drawn. Looked at last: reading a canvas back can stall the page for seconds
    // (headless Chromium), and a phone that misses a second of samples starts listening over.
    const inked = await page.locator('canvas.trace').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    expect(inked).toBeGreaterThan(100);
  });

  test('it says what this phone can feel: how far, how long, and who listens nearby', async ({ page, relay }) => {
    await page.goto(`/?relays=${relay.url}#sensor`);
    const card = page.getByTestId('can-feel');
    await expect(card).toContainText('Start the sensor to see how far away it would notice a quake.');
    await expect(card).toContainText('Listening time: none this session, none this week.');
    await expect(card).toContainText('Set a location to see the phones and quakes near you.');
    await page.getByLabel('Latitude').fill('37.77');
    await page.getByLabel('Longitude').fill('-122.42');
    await page.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByTestId('neighbours')).toHaveText('No other phones heard listening within 25 km.');
    const phone = (lat: number, lon: number, sps = 50) => signHeartbeat(generateSecretKey(), { lat, lon, noise: 0.01, sps });
    await send(relay.url, [phone(37.8, -122.27), phone(37.7, -122.47), phone(37.75, -122.4, 0), phone(38.58, -121.49)]);
    await expect(page.getByTestId('neighbours')).toHaveText('Heard from 2 other phones listening within 25 km.');

    await page.getByTestId('start').click();
    await feed(page, synthesize({ start: 0, durationS: 8, seed: 1 }));
    await expect(page.getByTestId('sensor-state')).toHaveText('Listening', { timeout: 10_000 });
    await expect(page.getByTestId('reach')).toHaveText('Would notice an M4 within about 50 km and an M5 within about 90 km.');
    await expect(card).toContainText('Listening time: under a minute this session, under a minute this week.');
    await expect(card).toContainText('No USGS quake since it began listening was strong enough here to register.');
  });

  test('works by keyboard: focus stays put as the screen redraws, and typed coordinates are kept', async ({ page }) => {
    await page.goto('/#sensor');
    await page.getByTestId('start').focus();
    const tab = async (to: import('@playwright/test').Locator) => {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
      await expect(to).toBeFocused();
    };
    await tab(page.getByLabel('Share with the Tremor network'));
    await tab(page.getByRole('button', { name: 'Use my approximate location' }));
    await tab(page.getByLabel('Latitude'));
    await page.keyboard.type('37.77493');
    await tab(page.getByLabel('Longitude'));
    await page.keyboard.type('-122.41942');
    await tab(page.getByRole('button', { name: 'Set' }));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('loc')).toHaveText('37.77°N 122.42°W');
    await expect(page.getByRole('button', { name: 'Set' })).toBeFocused();
    await page.getByTestId('start').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop sensor' })).toBeFocused();
  });

  test('Enter in a coordinate box sets the location and shows it at once', async ({ page }) => {
    await page.goto('/#sensor');
    await page.getByLabel('Latitude').fill('37.77493');
    await page.getByLabel('Longitude').fill('-122.41942');
    await page.getByLabel('Longitude').press('Enter');
    await expect(page.getByTestId('loc')).toHaveText('37.77°N 122.42°W');
    await expect(page.getByLabel('Longitude')).toBeFocused();
  });

  test('nothing is published until the user opts in', async ({ page, relay }) => {
    await page.goto(`/?relays=${relay.url}#sensor`);
    await page.getByTestId('start').click();
    await feed(page, synthesize({ start: 0, durationS: 8, seed: 1 }));
    await expect(page.getByTestId('sensor-state')).toHaveText('Listening', { timeout: 10_000 });
    expect(relay.events()).toEqual([]);
  });

  test('denied motion access explains itself', async ({ page }) => {
    await page.addInitScript(() => {
      (DeviceMotionEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission = async () => 'denied';
    });
    await page.goto('/#sensor');
    await page.getByTestId('start').click();
    await expect(page.getByTestId('sensor-state')).toHaveText('Motion access denied');
  });

  test('a computer without an accelerometer says so', async ({ page }) => {
    await page.goto('/#sensor');
    await page.getByTestId('start').click();
    await expect(page.getByTestId('sensor-state')).toHaveText('Warming up');
    await expect(page.getByTestId('sensor-state')).toHaveText('No motion data', { timeout: 8_000 });
  });
});
