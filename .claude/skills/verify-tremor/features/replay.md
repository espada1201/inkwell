# Replay

Replay plays a real quake into a network of simulated phones: each phone's record runs through the same detector a real phone uses and every alert through the same network code. The reader watches the network declare, confirm and locate it, sees how many phones were warned before the strong shaking, and compares the result with the USGS catalogue. A no-quake evening shows the detector rejecting footsteps and slams.

## Sub-features

- `replay-scenario` plays a bundled quake (Napa M6.0, Ridgecrest M7.1, Christchurch M6.1) to a declaration, a confirmation and a warning-time card. Leaving for another tab and coming back by the Replay tab carries on with the quake that was loaded.
- `replay-near` says, for the town the quake is named for (the biggest town within 10 km of the epicentre, else the nearest within 25 km: Napa for the Napa replay) and for the saved location when phones are within 15 km of it, how much warning the simulated phones within 15 km of it had, in the warning card. The bars have a labelled axis (`0 s`, longest warning, longest lead of the shaking) and a sentence saying what up and down mean.
- `replay-phone` answers a press on a simulated phone's dot, or on its row in `Phone by phone`, with a popup: its distance from the epicentre and its seconds of warning. The nearest town is also marked on the map with its name, without the online basemap's labels.
- `replay-compare` compares the simulated phones' location, time and magnitude with the USGS catalogue, with a link to its event page. It says how far off the location could be (`± N km`, also a dashed ring on the map) and gives the magnitude as a range, and notes that real phones size quakes more roughly than simulated ones.
- `replay-no-quake` plays Concert night, which raises no alert, and counts the withdrawn picks by the phone's reason.
- `replay-controls` plays, pauses, changes speed and scrubs, by pointer and by keyboard.
- `replay-milestones` tells screen readers each milestone once (declared, confirmed, finished), not every second.
- `replay-recent` lists the newest M4 or larger quakes in the USGS feed and replays one with simulated phones, around the saved location when it is within 150 km.
- `replay-link` reopens any replay from its address, including a recent quake after it leaves the feed, and follows an address edited in place; a mangled link plays Napa.

## How to get to it (user POV)

- The `Replay` tab, which opens the last replay or Napa.
- A scenario card in the `Scenarios` group (`data-scenario="napa-2014"`, `ridgecrest-2019`, `christchurch-2011`, `stadium-night`).
- `Replay with simulated phones` beside a quake under `Recent quakes`.
- An address: `#replay/<scenario id>` or `#replay/usgs/<id>/<time ms>/<lat>/<lon>/<depth km>/<mag>`; `?speed=4` or `10` before the hash.

## Driving it with drive.mjs

Preconditions: the baseline; `open('#replay/napa-2014', 'speed=10')` unless a step says otherwise.

- **Declare and confirm (`replay-scenario`).** Wait for `getByTestId('replay-status')` to read `Network declares a quake at T+…`, then for `getByTestId('play')` to read `Replay`. The timeline `What the network knew, and when` has 4 `li.done`; `getByTestId('warned')` reads `warned/felt`, with most of the felt phones warned for Napa. Right under it `warning-near` reads `Near Napa (10 km from the epicentre): shaking came 0.5–3.7 s before the alert (4 phones within 15 km), so no warning.`; with a location saved near Napa a second line `warning-near-you` names that place. The bars sit on a `0 s` line with `+N s` above it and `−N s` below, and the text under them says what red and grey mean. The map shows a square and the name `Napa` near the epicentre.
- **Phone popup (`replay-phone`).** Press `Phone by phone` (a `details`, `data-testid=phone-list`) and a row in it, or a phone's dot on the map: a popup reads `Simulated phone, N.N km from the epicentre. …` with its seconds, and its `Close popup` button works. The dots take a press within about 10 px.
- **Compare (`replay-compare`).** In `getByTestId('compare')`, `est-loc` carries `data-lat`/`data-lon` within about 15 km of the USGS epicentre (Napa 38.215, −122.312) and `verdict` starts `Off by`. `est-km` reads `± N km` and the USGS epicentre lies within N km of `est-loc`; `est-mag` reads a range such as `M5.3–6.4` that holds 6.0. Below the card a line starts `Simulated phones shake by the same model`. The map shows a dashed ring labelled `± N km`, and the `Key` lists `where a detection could be`, `blind zone: the strong shaking got there before the alert` and `5, 10 and 20 s rings: …`. The `USGS page` link points at `earthquake.usgs.gov/earthquakes/eventpage/…`.
- **No quake (`replay-no-quake`).** `open('#replay/stadium-night', 'speed=10')`. When `play` reads `Replay`, `warning` contains `No alert`, there is no `compare`, `replay-status` reads `Replay finished: no quake declared.` and `replay-stats` reads `40 simulated phones · N confirmed · N picks withdrawn on-device (footsteps N, …)`.
- **Controls (`replay-controls`).** Press `Pause` (the clock stops), the `10×` button in `Playback speed` (its `aria-pressed` turns true), then focus the `Replay position` slider and press `Home` and `ArrowRight`: the clock and the timeline follow.
- **Milestones (`replay-milestones`).** Record `replay-status` text every 250 ms through a Napa run: no more than four distinct lines, ending in `Replay finished: declared at …, confirmed at …`.
- **Recent quake (`replay-recent`).** `usgs([{ id: 'nc1', mag: 4.8, place: '10 km E of Test, CA', time: Date.now() - 3600e3, lat: 37.8, lon: -122.2 }])`, then `open('#replay')`. Under `Recent quakes` press `Replay with simulated phones` for it: the blurb says the quake is real and the phones simulated, around the epicentre; the address becomes `#replay/usgs/nc1/…`.
- **Link (`replay-link`).** Reopen that address in the same run: the same quake plays. `open('#replay/usgs/x/1e20/37.8/-122.2/8/4.6')` plays Napa instead and logs no error. Set `location.hash` to `#replay/ridgecrest-2019`: Ridgecrest plays. Open `#replay/christchurch-2011`, press the `About` tab, then the `Replay` tab: Christchurch is still the one pressed.

## Gotchas

- `speed` is a query parameter, before the hash; typed after it, it is ignored and the scenario still plays.
- `replay-status` is visually hidden on purpose; read it with `innerText`, don't expect to see it in a shot.
- Without a quake the clock counts `m:ss` into the replay; with one it counts `T±s` from the origin.
- A recent quake is offered only at M4 or more, and only while it is in the feed; the link keeps working after.
- The phones of a recent quake sit around the saved location only when it is within 150 km; the sensor screen's form sets one.
