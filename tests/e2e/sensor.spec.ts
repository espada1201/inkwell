import { synthesize } from '../../src/core/synth';
import { expect, test } from './fixtures';

/** Feed a recorded accelerometer series to the page as DeviceMotion events, in real time (50 Hz). Returns the wall clock time of its start. */
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

    await page.getByLabel('Latitude').fill('37.77493');
    await page.getByLabel('Longitude').fill('-122.41942');
    await page.getByRole('button', { name: 'Set' }).click();
    await expect(page.getByTestId('loc')).toHaveText('37.77°N 122.42°W');
    await page.getByLabel('Share with the Tremor network').check();
    await expect(page.getByTestId('publish-note')).toContainText('On.');

    await page.getByTestId('start').click();
    const start = await feed(page, synthesize({ start: 0, durationS: 34, seed: 3, quake: { tP: 10, tS: 13, pga: 0.8 } }));
    await expect(page.getByTestId('sensor-state')).toHaveText('Listening', { timeout: 10_000 });
    // The background it learned while warming up: about 12.5 mm/s² for this record.
    await expect(page.getByTestId('background')).toHaveText(/^1[0-5]\.\d mm\/s²$/);
    await expect(page.getByTestId('meter-word')).toHaveText('Quiet');

    // The live trace is drawn.
    const inked = await page.locator('canvas.trace').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    expect(inked).toBeGreaterThan(100);

    // The provisional pick marks the onset within a second of the P wave reaching the phone, 10 s in...
    await expect.poll(() => relay.events().filter((e) => e.kind === 4578).length, { timeout: 20_000 }).toBe(1);
    const onset = JSON.parse(relay.events().find((e) => e.kind === 4578)!.content).t - (start + 10_000);
    expect(onset).toBeGreaterThan(0);
    expect(onset).toBeLessThan(1000);
    await expect(page.getByTestId('meter-word')).toHaveText('Shaking');
    // ...and the vetted trigger follows 15–30 s after the onset, linked to it.
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
