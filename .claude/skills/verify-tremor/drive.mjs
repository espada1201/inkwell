#!/usr/bin/env node
// Drive a running Tremor in Chromium through one journey and keep the evidence. See SKILL.md.
//   node .claude/skills/verify-tremor/drive.mjs <journey.mjs> [--phone] [--real]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, devices } from '@playwright/test';
import { createServer } from 'vite';
import { startRelay } from '../../../tests/fake-relay.mjs';

const args = process.argv.slice(2);
const journeyPath = args.find((a) => !a.startsWith('--'));
if (!journeyPath) throw new Error('usage: drive.mjs <journey.mjs> [--phone] [--real]');
const real = args.includes('--real');
const base = process.env.TREMOR_URL ?? 'http://127.0.0.1:4173/';
const out = resolve(process.env.EVIDENCE ?? join(tmpdir(), 'verify-tremor', `${Date.now()}`));
mkdirSync(out, { recursive: true });
const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(preinstalled) ? preinstalled : undefined);

// The app's own modules (protocol, scenarios, synth…) for journeys that publish as phones would.
const vite = await createServer({ root: resolve(import.meta.dirname, '../../..'), appType: 'custom', server: { middlewareMode: true }, logLevel: 'error' });
const relay = real ? null : await startRelay(0);
const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext(args.includes('--phone') ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1360, height: 860 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

const now = Date.now();
let usgs = [
  { id: 'us1', mag: 4.6, place: 'Central California', time: now - 20 * 60_000, lat: 36.6, lon: -121.2 },
  { id: 'us2', mag: 5.4, place: 'off the east coast of Honshu, Japan', time: now - 5 * 3600_000, lat: 38.1, lon: 142.3 },
];
if (!real) {
  // Isolated: a private relay, a USGS feed of the journey's choosing, and no internet tiles (the bundled coastline shows).
  await page.route('**/earthquake.usgs.gov/earthquakes/feed/**', (r) =>
    r.fulfill({
      json: {
        type: 'FeatureCollection',
        features: usgs.map((q) => ({ id: q.id, properties: { mag: q.mag, place: q.place, time: q.time, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${q.id}` }, geometry: { type: 'Point', coordinates: [q.lon, q.lat, q.depth ?? 10] } })),
      },
    }),
  );
  await page.route('**/tiles.openfreemap.org/**', (r) => r.abort());
  await page.routeWebSocket(/^wss:\/\//, (ws) => ws.close());
}

const notes = [];
const ctx = {
  page,
  relay,
  real,
  out,
  /** Load one of the app's modules, e.g. '/src/net/protocol.ts'. */
  app: (path) => vite.ssrLoadModule(path),
  /** Open a screen by its hash, e.g. '#replay/napa-2014', on the private relay unless --real. */
  open: (hash, query = '') => page.goto(`${base}?${relay ? `relays=${relay.url}&` : ''}${query}${hash}`),
  /** Replace the USGS feed the page sees (isolated runs only), before the screen loads. */
  usgs: (rows) => (usgs = rows),
  shot: (name) => page.screenshot({ path: join(out, `${name}.png`) }),
  aria: async (name, locator = page.locator('body')) => writeFileSync(join(out, `${name}.aria.yml`), await locator.ariaSnapshot()),
  note: (text) => notes.push(text),
};

let failure = null;
try {
  await (await import(pathToFileURL(resolve(journeyPath)).href)).default(ctx);
} catch (e) {
  failure = e;
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
}
// Aborted tiles are this harness's doing, and the browser logs each one.
const unexpected = errors.filter((e) => real || !/ERR_FAILED|tiles\.openfreemap/.test(e));
writeFileSync(join(out, 'console-errors.txt'), errors.join('\n'));
writeFileSync(join(out, 'relay-events.json'), JSON.stringify(relay?.events() ?? [], null, 1));
writeFileSync(join(out, 'notes.md'), notes.map((n) => `- ${n}`).join('\n'));
const ok = !failure && !unexpected.length;
writeFileSync(join(out, 'result.json'), JSON.stringify({ journey: journeyPath, url: base, real, ok, error: failure ? String(failure.stack ?? failure) : null, unexpectedConsoleErrors: unexpected }, null, 1));
await browser.close();
await relay?.close();
await vite.close();
console.log(`${ok ? 'PASS' : 'FAIL'} ${journeyPath}\nevidence: ${out}`);
process.exit(ok ? 0 : 1);
