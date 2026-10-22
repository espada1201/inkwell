# Tremor

A citizen seismometer network with no server. A phone lying on a table becomes a seismometer in the
browser. It signs what it feels and publishes it over public [Nostr](https://nostr.com) relays. Any
browser watching them finds the quakes, locates them, and checks itself against the official USGS
feed. Old phones become community infrastructure.

## Run on your Mac

1. Open the Terminal app. If `brew -v` says command not found, install Homebrew from
   https://brew.sh and run the "Next steps" lines it prints.
2. Install Node: `brew install node`
3. On this page click **Code**, then **Download ZIP**, and unzip it. In Terminal type `cd ` (with a
   space), drag the unzipped folder onto the Terminal window and press Return.
4. Start Tremor: `npm install && npm start`
5. Open the address it prints (http://localhost:4173). Press Ctrl+C in Terminal to stop.

**Make a phone a sensor.** Phones only share their motion sensor with secure (https) pages. Run
`npm run phone` instead, open the `https://…:4443` "Network" address it prints on a phone on the
same Wi-Fi and accept the certificate warning (or use the Pages site, below). Lay the phone flat,
plug it in, tap **Start sensor**, set a rough location and switch sharing on.

## What it does

- **Be a sensor.** The phone removes gravity, filters to 1–10 Hz and runs an STA/LTA trigger. About
  a second after shaking arrives it sends a *pick*, P or S by which way it shakes. For 15–30 s the
  phone checks the pick against the earlier background (picked up, door slam, footsteps), then
  confirms it as a *trigger* or retracts it. A card says how far away it would notice a quake.
- **Network.** It shows reports near you and a live map. Picks that fit one wavefront from 4 or more
  phones in 3 or more places flag a provisional quake in seconds, unless quiet phones nearby outvote
  them. Triggers give the epicentre (± km), a rough magnitude and a USGS check. Anyone can say "I
  felt it" (shown once 3 people in 3 places agree). An opt-in chime marks confirmed shaking nearby.
- **Replay.** Real quakes (Napa 2014, Ridgecrest 2019, Christchurch 2011, or any M4 or larger from
  the past day's USGS feed) and a concert night with no quake play out on simulated phones that run
  the same detector, with a record section, a timeline and each phone's seconds of warning.
- **Plan.** How many phones does a city, or your own area, need? Between 5 and 2,000 simulated
  phones, modelled on the real detector and run through the same network code, face 24 quakes and
  a busy hour without one. A curve shows the results for 10 to 1,000 phones.

**Wire format.** Tremor sends signed Nostr events tagged `#tremor`: pick (kind 4578, `ph` is P or
S), confirmed report (4579), heartbeat (34579, replaceable), retraction (NIP-09) and felt report
(4580, level 1–5). The phone snaps locations to a 0.01° grid, about 1 km, as does every receiver.

## Honest limits

- Tremor is community science, not an official warning system. Phones feel only strong shaking
  nearby, and magnitudes are rough (big quakes read low). For alerts on Android, turn on Earthquake
  alerts in Settings under Safety & emergency (the path varies by maker). On the US West Coast, use
  Wireless Emergency Alerts and MyShake. Elsewhere, follow your national seismic service.
- Background tabs pause sensors and sounds: keep a sensor phone, or a page set to chime, on screen.
- Tremor is tuned on synthetic phone records; replays use real epicentres and simulated phones. The
  planner assumes uniform ground and one attenuation curve: read it as scale, not a forecast.
- Public relays are open: anyone could publish fake phones, picks or felt reports. Outside the US,
  USGS may not list quakes below about M4.5.

## Develop and publish

`npm run dev` · `npm run typecheck` · `npm test` · `npm run e2e` (Playwright; run `npx playwright
install chromium` once). CI builds and runs the last three on each push to `main` and pull request.
GitHub Pages deploys `main` once it is on: in Settings, under Pages, set Source to GitHub Actions.
