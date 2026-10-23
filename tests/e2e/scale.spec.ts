import { writeFileSync } from 'node:fs';
import { crowd, signedCrowd } from '../scale';
import { expect, test } from './fixtures';
import { send } from './publish';

const PHONES = Number(process.env.SCALE_PHONES) || 3000;

test(`a quake over ${PHONES} listening phones keeps the page responsive`, async ({ page, relay }, testInfo) => {
  test.setTimeout(10 * 60_000);
  // Signing thousands of events takes longer than a quake's picks stay fresh, so the page's clock
  // starts 25 seconds before the crowd was made, and is set again to just after it when picks go out.
  const made = Date.now();
  const events = signedCrowd(crowd(PHONES, made));
  const warmUp = signedCrowd(crowd(40, made, { lat: 35.6, lon: -117.7 }));
  await send(relay.url, events.heartbeats);
  await page.addInitScript((delta) => {
    const w = window as unknown as { clockShift: number };
    w.clockShift = delta;
    const Real = Date;
    class Shifted extends Real {
      constructor(...args: unknown[]) {
        if (args.length) super(...(args as [number]));
        else super(Real.now() + w.clockShift);
      }
      static now() {
        return Real.now() + w.clockShift;
      }
    }
    window.Date = Shifted as DateConstructor;
  }, made - 25_000 - Date.now());
  const clockAtCrowd = () => page.evaluate((at) => ((window as unknown as { clockShift: number }).clockShift = at - Date.now() + (window as unknown as { clockShift: number }).clockShift), made + 2000);

  await page.addInitScript(() => {
    const w = window as unknown as { long: { at: number; ms: number }[]; frames: number[] };
    w.long = [];
    w.frames = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => w.long.push({ at: e.startTime, ms: e.duration }))).observe({ type: 'longtask', buffered: true });
    const frame = (t: number) => (w.frames.push(t), requestAnimationFrame(frame));
    requestAnimationFrame(frame);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const phase = async <T>(name: string, run: () => Promise<T>) => {
    const before = await metrics();
    await page.evaluate(() => {
      const w = window as unknown as { long?: unknown[]; frames: number[] };
      if (!w.long) return;
      w.long.length = 0;
      w.frames.length = 0;
    });
    const began = Date.now();
    await run();
    const took = Date.now() - began;
    const after = await metrics();
    const seen = await page.evaluate(() => {
      const w = window as unknown as { long: { ms: number }[]; frames: number[] };
      const gaps = w.frames.slice(1).map((t, i) => t - w.frames[i]);
      return { long: w.long.length, blocked: w.long.reduce((s, e) => s + e.ms - 50, 0), longest: Math.max(0, ...w.long.map((e) => e.ms)), frames: w.frames.length, worstGap: Math.max(0, ...gaps) };
    });
    const row = {
      phase: name,
      phones: PHONES,
      wallMs: took,
      busyMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
      scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
      layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration + after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
      longTasks: seen.long,
      blockedMs: Math.round(seen.blocked),
      longestMs: Math.round(seen.longest),
      frames: seen.frames,
      worstFrameGapMs: Math.round(seen.worstGap),
      heapMB: Math.round(after.JSHeapUsedSize / 1e6),
      domNodes: after.Nodes,
    };
    console.log(JSON.stringify(row));
    testInfo.annotations.push({ type: `${name} (${PHONES} phones)`, description: JSON.stringify(row) });
    return row;
  };

  const load = await phase('load', async () => {
    await page.goto(`/?relays=${relay.url}#network`);
    await expect(page.getByTestId('stat-nodes')).toHaveText(String(PHONES), { timeout: 240_000 });
  });

  if (process.env.PROFILE) await cdp.send('Profiler.enable'), await cdp.send('Profiler.setSamplingInterval', { interval: 500 }), await cdp.send('Profiler.start');
  // A first quake on the map makes the browser build the shaders that draw it (seconds in software GL, a blink on a graphics card). That is the browser's one-time work, so it is done before the quake that is timed.
  await clockAtCrowd();
  await send(relay.url, [...warmUp.heartbeats, ...warmUp.picks]);
  await expect(page.getByTestId('provisional').first()).toBeVisible({ timeout: 120_000 });
  await send(relay.url, warmUp.triggers);
  await expect(page.getByTestId('stat-events')).toHaveText('1', { timeout: 120_000 });
  await page.getByTestId('event-list').getByRole('button').first().click();
  await page.waitForTimeout(4000);

  const quake = await phase('quake', async () => {
    await clockAtCrowd();
    for (let i = 0; i < events.picks.length; i += 100) {
      await send(relay.url, events.picks.slice(i, i + 100));
      await page.waitForTimeout(100);
    }
    await expect(page.getByTestId('provisional').first()).toBeVisible({ timeout: 120_000 });
    await send(relay.url, events.triggers);
    await expect(page.getByTestId('stat-events')).toHaveText('2', { timeout: 120_000 });
  });

  if (process.env.PROFILE) writeFileSync(process.env.PROFILE?.startsWith('/') ? process.env.PROFILE : testInfo.outputPath('page.cpuprofile'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
  const quiet = await phase('quiet', () => page.waitForTimeout(5000));
  expect(page.workers().length).toBeGreaterThan(0);
  for (const p of [load, quake, quiet]) expect(p.longestMs, `longest task while ${p.phase}`).toBeLessThan(4000);
  // A single longest task is noisy on a busy machine: the totals show whether the work came back, the longest only that nothing holds the page for half a second.
  expect(quake.scriptMs, 'script time while the quake is found').toBeLessThan(6500);
  expect(quake.blockedMs, 'time past 50 ms in long tasks while the quake is found').toBeLessThan(3500);
  expect(quake.longestMs, 'longest task while the quake is found').toBeLessThan(450);
  expect(quiet.busyMs, 'main-thread time in 5 quiet seconds').toBeLessThan(2500);
});
