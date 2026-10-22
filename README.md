# Tremor

A citizen seismometer network with no server. A phone lying on a table becomes a seismometer in the
browser. It signs what it feels and publishes it over public [Nostr](https://nostr.com) relays. Any
browser watching them finds the quakes, locates them, and checks itself against the official USGS
feed. Old phones become community infrastructure.

## Run on your Mac

1. Open the Terminal app. If `brew -v` says command not found, install Homebrew from
   https://brew.sh and run the "Next steps" lines it prints.
2. Install Node: `brew install node`
3. On this page click **Code → Download ZIP** and unzip it, then: `cd ~/Downloads/inkwell-main`
4. Start Tremor: `npm install && npm start`
5. Open the address it prints (http://localhost:4173). Press Ctrl+C in Terminal to stop.

**Make a phone a sensor.** Phones only share their motion sensor with secure (https) pages. Run
`npm run phone` instead, open the `https://…:4443` "Network" address it prints on a phone on the
same Wi-Fi and accept the certificate warning (or use the Pages site, below). Lay the phone flat,
plug it in, tap **Start sensor**, set a rough location and switch sharing on.

## What it does

- **Be a sensor**: accelerometer → gravity removal → 1–10 Hz bandpass → STA/LTA trigger with an
  adaptive threshold. A provisional *pick* goes out within half a second, labelled P or S by
  which way the phone shakes (P waves are mostly up and down, S side to side). The phone then
  vets it for 15–30 s (rotated = picked up, under 1 s = door slam, many short knocks = footsteps)
  and either confirms it as a *trigger* or retracts it. Screen wake lock, battery readout, dim mode.
- **Network**: live map of phones, picks, detections and USGS quakes. Four or more picks that fit
  one wavefront, which the quiet phones nearby do not outvote, declare a provisional quake within
  seconds. Vetted triggers then give the epicentre (grid search on arrival times), a rough
  magnitude, a crowd shaking map and a side-by-side check against USGS.
- **Replay**: real historical quakes (Napa 2014, Ridgecrest 2019, Christchurch 2011) and a
  concert night with no quake, played into simulated phones that run the same detector, with a
  record section, a timeline and how many seconds of warning each phone would have had.
- **Plan**: how many phones does a city need? 5 to 2,000 simulated phones, modelled on the real
  detector and run through the same network code, face 24 quakes and 12 busy quake-free minutes,
  plus a curve from 10 to 1,000 phones.

**Wire format**: signed Nostr events tagged `#tremor`: pick (kind 4578, `ph` = P or S), trigger
(4579), heartbeat (34579, replaceable) and retraction (NIP-09 deletion). Locations are snapped
to a 0.01° (~1 km) grid on the phone and again on every receiver. Relays are editable in the app.

## Honest limits

- Community science, not an official warning system. Phones only feel strong shaking nearby, and
  magnitudes are rough (±0.5–1). Use the alerts from your national seismic service.
- Browsers pause sensors in background tabs: a sensor phone must stay open on screen, plugged in.
- The detector is tuned on synthetic phone records; replays use real epicentres, simulated phones.
  The planner assumes uniform ground and one attenuation curve: read it as scale, not a forecast.
- Public relays are open, so a determined person could publish fake picks.

## Develop and publish

`npm run dev` (hot reload) · `npm run typecheck` · `npm test` (Vitest) · `npm run e2e` (Playwright;
`npx playwright install chromium` once). CI runs these and the build on pushes to `main` and PRs.

**GitHub Pages**: the Pages workflow deploys `main` once Pages is switched on (Settings → Pages →
Source: GitHub Actions); it needs a public repository. If this repo is renamed to `tremor`, links
follow and the unzipped folder becomes `tremor-main`. MIT licence.
