---
name: verify-tremor
description: Launch Tremor (this repo's citizen-seismometer web app), check the instance is the one you built, and drive its five screens in Chromium like a user, keeping screenshots, ARIA snapshots and relay logs as proof. Use before saying a Tremor feature works, when checking that the README and About page match the app, or to verify every feature in the map.
---

# Verify Tremor

Tremor is a static web app with no backend: phones publish signed Nostr events to public relays, and any browser associates them into located quakes and checks them against the USGS feed. Verification serves the built app the way the README tells a user to, then drives it through `drive.mjs`, which owns the browser, a private relay, the routed outside world and the evidence folder. `features/` says what to drive and what proves it.

## Launch

1. `npm ci` once (Node 22+). Never run `playwright install`: the helper uses the preinstalled Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, or `CHROMIUM_PATH`.
2. Pick a run folder outside the repo, e.g. `RUN=$(mktemp -d)/verify-tremor`, and `mkdir -p $RUN`.
3. Build and serve with the two commands `npm start` runs (`http://localhost:4173/`, strict port), minus npm's wrapper so the PID you keep is the server's. Stopping `npm start` by its PID leaves its Vite child serving.

   ```sh
   node node_modules/vite/bin/vite.js build > $RUN/build.log 2>&1
   node node_modules/vite/bin/vite.js preview --port 4173 --strictPort > $RUN/server.log 2>&1 & echo $! > $RUN/server.pid
   ```

4. Ready when `$RUN/server.log` has `Local:` and `curl -s http://127.0.0.1:4173/` contains `<title>Tremor`.

Port 4173 already taken by something you did not start: leave it alone, serve on a free port (`--port 4180`) and pass `TREMOR_URL=http://127.0.0.1:4180/` to the drives. Each launch rebuilds, so the instance runs the checkout as it is now. Whether `npm start` itself works from a fresh clone is a separate check, not part of a drive.

## Doctor

Read-only. Run it first, and again whenever a drive surprises you:

```sh
curl -s ${TREMOR_URL:-http://127.0.0.1:4173/} | grep -o '<title>[^<]*'   # Tremor answers
lsof -nP -iTCP:4173 -sTCP:LISTEN -t; cat $RUN/server.pid                # one listener, and it is yours
ls -l dist/index.html; git status --short                               # built after your last edit
```

Real-network drives (`--real`) also need outbound WebSockets and the USGS feed: `curl -sI https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` must answer 200. Sandboxes usually refuse both, so drive isolated there and say so in the report.

## Drive

```sh
EVIDENCE=$RUN/<feature-id> node .claude/skills/verify-tremor/drive.mjs <journey.mjs> [--phone] [--real]
```

A journey is a scratch ES module, never committed, whose default export receives:

- `open(hash, query?)`: opens a screen, e.g. `open('#replay/napa-2014', 'speed=10')`. Isolated runs add `?relays=<private relay>`.
- `usgs(rows)`: the USGS feed the page will see in isolated runs; call it before `open`. A row is `{ id, mag, place, time, lat, lon, depth? }`. Two recent quakes are there by default.
- `app(path)`: the app's own modules through Vite, so a journey publishes exactly what a phone would. `app('/tests/e2e/publish.ts')` gives `scenarioEvents(id)` (a bundled quake run through the real detector and signed per phone: `heartbeats`, `picks`, `finals`) and `send(url, events)`; `app('/src/net/protocol.ts')` gives `signHeartbeat`, `signPick`, `signTrigger`, `signRetraction`.
- `relay`: the private relay, `relay.url` and `relay.events()` (what the page published). Null with `--real`.
- `page`: the Playwright page. Find things by role, accessible name or `data-testid`, as the feature files list them; never by coordinates.
- `shot(name)`, `aria(name, locator?)`, `note(text)`: evidence.

`--phone` drives a 390×844 Pixel 7. `--real` routes nothing: public relays, the live USGS feed, online map tiles. Isolated runs close public relays, abort map tiles (the bundled coastline and an "Offline basemap" note show) and serve USGS from `usgs(rows)`. The helper prints `PASS` and exits 0 when the journey finished and the page logged no console error the harness did not cause.

## Evidence

All of it lands in `$EVIDENCE`: the journey's screenshots and ARIA snapshots, `notes.md`, `console-errors.txt` (every one; aborted tiles are expected in isolated runs), `relay-events.json` and `result.json` (pass or fail, the error, unexpected console errors). Proof means:

- The user's path: tabs, buttons, keyboard, typed text and links, not internal setters or `window` hooks.
- The action and the state after it: a shot or note before, and one after.
- Side effects checked too: what reached the relay, what the address bar says, what a reload keeps (`tremor.location`, `tremor.join`, `tremor.relays`, `tremor.sk` in localStorage).
- Mocks only at Tremor's own boundaries: relays (private relay), USGS (routed feed), map tiles (aborted), the motion sensor (DeviceMotion events, see `features/sensor.md`), the browser's geolocation, and the speaker, vibration and notifications (counted, see `features/network.md`). Name the ones a proof used.
- Every entry point a feature file lists is driven, or reported as not verified with the reason. Never a PASS through a different path.

## Cleanup

- `kill $(cat $RUN/server.pid)`, then `lsof -nP -iTCP:4173 -sTCP:LISTEN -t` prints nothing. Kill only PIDs you recorded, never by name: other checkouts run Vite too.
- `drive.mjs` closes its own browser, relay and module loader, even when a journey fails.
- Keep `$RUN`: the evidence is the deliverable.

## Feature map

`features/README.md` indexes one file per screen: sub-feature IDs, entry points, journey recipes and gotchas. When the app changes, change its file in the same commit (pstack's maintain-verification-skill).
