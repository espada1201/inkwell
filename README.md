# Tremor

A citizen seismometer network with no server. A phone lying on a table becomes a seismometer in
the browser. It signs what it feels and publishes it over public [Nostr](https://nostr.com) relays.
Any browser watching those relays finds the quakes, locates them, and checks itself against the
official USGS feed. Old phones become community infrastructure.

## Run on your Mac

1. Open the Terminal app. If `brew` is missing, install Homebrew first from https://brew.sh.
2. Install Node: `brew install node`
3. On this page click **Code → Download ZIP**, unzip it, then in Terminal: `cd ~/Downloads/inkwell-main`
4. Start Tremor: `npm install && npm start`
5. Open the address it prints (http://localhost:4173). Press Ctrl+C in Terminal to stop.

**Make a phone a sensor.** Phones only share their motion sensor with secure (https) pages. Run
`npm run phone` instead, then on a phone on the same Wi-Fi open the `https://…:4443` "Network"
address it prints and accept the certificate warning. Or use the GitHub Pages site below. Lay the
phone flat, plug it in, tap **Start sensor**, set a rough location and switch sharing on.

## What it does

- **Be a sensor**: accelerometer → gravity removal → 1–10 Hz bandpass → STA/LTA trigger with an
  adaptive threshold. A provisional *pick* goes out the instant shaking starts; the phone then
  vets it for 15 s (rotated = picked up, under 1 s = door slam, many short knocks = footsteps)
  and either confirms it as a *trigger* or retracts it. Screen wake lock, battery readout, dim mode.
- **Network**: live map of phones, picks, detections and USGS quakes. Four picks that fit one
  P wave, and that the phones which stayed quiet do not contradict, declare a provisional quake
  within seconds. Vetted triggers then give the epicentre (grid search on arrival times), a rough
  magnitude, a crowd shaking map and a side-by-side check against USGS.
- **Replay**: real historical quakes (Napa 2014, Ridgecrest 2019, Christchurch 2011) and a
  concert night with no quake, played into simulated phones that run the same detector, with a
  record section, a timeline and how many seconds of warning each phone would have had.

**Wire format**: signed Nostr events tagged `#tremor`: pick (kind 4578), trigger (4579),
heartbeat (34579, replaceable) and retraction (NIP-09 deletion). Locations are snapped to a
0.01° (~1 km) grid on the phone and again on every receiver. Relays are editable in the app.

## Honest limits

- Community science, not an official warning system. Phones only feel strong shaking nearby, and
  magnitudes are rough (±0.5–1). Use the alerts from your national seismic service.
- Browsers pause sensors in background tabs: a node must stay open on screen, ideally plugged in.
- The detector is tuned on synthetic phone records; replays use real epicentres, simulated phones.
- Public relays are open, so a determined person could publish fake triggers.

## Develop

`npm run dev` (hot reload) · `npm run typecheck` · `npm test` (Vitest) · `npm run e2e`
(Playwright, run `npx playwright install chromium` once). CI runs all four on every push.

## Publish on GitHub Pages

The Pages workflow deploys `main` once Pages is switched on (Settings → Pages → Source: GitHub
Actions). Pages needs a public repository. This repo may be renamed to `tremor`; links follow.

MIT licence.
