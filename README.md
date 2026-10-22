# Tremor

A citizen seismometer network with no server. A phone lying on a table becomes a seismometer in the
browser. It signs what it feels and publishes it over public [Nostr](https://nostr.com) relays. Any
browser watching them finds the quakes, locates them, and checks itself against the official USGS
feed. Old phones become community infrastructure.

## Run on your Mac

1. Open the Terminal app. If `brew -v` says command not found, install Homebrew from
   https://brew.sh and run the "Next steps" lines it prints.
2. Install Node: `brew install node`
3. On this page click **Code → Download ZIP** and unzip it. In Terminal type `cd ` (with a space),
   drag the unzipped folder onto the Terminal window and press Return.
4. Start Tremor: `npm install && npm start`
5. Open the address it prints (http://localhost:4173). Press Ctrl+C in Terminal to stop.

**Make a phone a sensor.** Phones only share their motion sensor with secure (https) pages. Run
`npm run phone` instead, open the `https://…:4443` "Network" address it prints on a phone on the
same Wi-Fi and accept the certificate warning (or use the Pages site, below). Lay the phone flat,
plug it in, tap **Start sensor**, set a rough location and switch sharing on.

## What it does

- **Be a sensor**: accelerometer → gravity removal → 1–10 Hz bandpass → STA/LTA trigger. A *pick*,
  P or S by which way the phone shakes, goes out about a second after the shaking arrives; for
  15–30 s the phone checks it against the earlier background (picked up, door slam, footsteps),
  then confirms it as a *trigger* or retracts it. A card says how far away it would notice a quake.
- **Network**: what was reported near you, then a live map. Picks from 4+ phones in 3+ places that
  fit one wavefront, and that quiet phones nearby do not outvote, declare a provisional quake in
  seconds; vetted triggers give the epicentre (± km), a rough magnitude and a USGS check. Anyone
  can say "I felt it" (shown once 3 people in 3 places agree); an opt-in chime marks shaking nearby.
- **Replay**: real quakes (Napa 2014, Ridgecrest 2019, Christchurch 2011, or any M4+ from the
  past day's USGS feed) and a concert night with no quake, played into simulated phones that run
  the same detector, with a record section, a timeline and each phone's seconds of warning.
- **Plan**: how many phones does a city, or your own area, need? 5 to 2,000 simulated phones,
  modelled on the real detector and run through the same network code, face 24 quakes and a busy
  hour without one, plus a curve from 10 to 1,000 phones.

**Wire format**: signed Nostr events tagged `#tremor`: pick (kind 4578, `ph` = P or S), confirmed
report (4579), heartbeat (34579, replaceable), retraction (NIP-09) and felt report (4580, level
1–5). Locations are snapped to a 0.01° (~1 km) grid on the phone and on every receiver.

## Honest limits

- Community science, not an official warning system: phones feel only strong shaking nearby, and
  magnitudes are rough (big quakes read low). For alerts, on Android turn on Earthquake alerts
  (Settings → Safety & emergency; it varies by maker), on the US West Coast use Wireless Emergency
  Alerts and MyShake, elsewhere your national seismic service.
- Background tabs pause sensors and sounds: keep a sensor phone, or a page set to chime, on screen.
- Tuned on synthetic phone records; replays use real epicentres and simulated phones. The planner
  assumes uniform ground and one attenuation curve: read it as scale, not a forecast.
- Public relays are open: anyone could publish fake phones, picks or felt reports. Outside the US,
  USGS may not list quakes below about M4.5.

## Develop and publish

`npm run dev` (hot reload) · `npm run typecheck` · `npm test` · `npm run e2e` (Playwright; `npx
playwright install chromium` once). CI runs them on every push to `main`. **GitHub Pages** deploys
`main` once switched on (Settings → Pages → Source: GitHub Actions). MIT licence.
