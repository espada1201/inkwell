# Network

The Network screen answers "was that a quake, near me?". A card lists what was reported near the reader's location, nearest first. Below it, the screen counts the phones listening on the relays this browser follows, turns their picks into a provisional detection within seconds, turns their vetted triggers into a confirmed, located quake, and checks each against the USGS feed, which it also lists. Anyone can report shaking they felt, and an opt-in chime sounds for shaking near the reader that phones confirmed or USGS lists, while the tab is open. Forged or malformed events are ignored, and the relays in use can be changed.

## Sub-features

- `net-near` asks once for a location (typed, or the browser's), keeps it, and lists Tremor detections and felt shakings within 100 km and USGS quakes within 300 km that would have been felt there at least weakly, nearest first, with the distance and a rough local shaking word (quakes below M2.5 read weak at most). While this phone shares as a sensor, the card links to `#sensor` instead of offering `change`, since moving it would misplace the phone's picks. After light or stronger shaking it adds Drop, Cover and Hold On and a link to `#sensor`; with nothing near, it says nothing strong enough to feel was reported and how soon USGS usually posts.
- `net-phones` counts phones from their heartbeats; a phone that stopped or went quiet stops counting.
- `net-provisional` shows a provisional detection, as an alert, from raw picks that fit one wavefront, with how far off its place could be, then keeps it listed for two hours with how it ended: confirmed, or not confirmed with the phones' reasons.
- `net-confirmed` lists a confirmed quake from vetted triggers, located, sized and marked `Matches USGS` when the feed has it; selecting it shows the comparison, with how far off the place (`± N km`, and a dashed ring on the map) and the magnitude (a range) could be, nine times in ten as measured on simulated quakes, and that big quakes read low.
- `net-felt` takes an "I felt it" report from the header or the card: five levels, one tap, at most one per key per ten minutes, with a `Tell USGS too` link to the matching USGS event or to Did You Feel It. A shaking shows once three people in three places agree; one key reporting from many places shows nothing.
- `net-chime` sounds, vibrates, notifies and shows a dismissable alert once per light or stronger shaking near the reader that phones confirmed or USGS lists, only after they tick the box, never for withdrawn picks, provisional detections, what people say they felt, weak shaking, shaking listed before the tick or shaking older than 30 minutes.
- `net-usgs` lists the USGS feed for the past day or hour, nearest first or worldwide, with loading and calm error states and the note that USGS may miss quakes below about M4.5 outside the US.
- `net-hostile` drops forged and malformed events without breaking the page.
- `net-relays` counts open relays, says plainly when none can be reached, and edits the list: only `wss://` lines are saved, the saved list survives a reload.
- `net-offline-map` falls back to a bundled coastline when map tiles cannot load.

## How to get to it (user POV)

- The `Network` tab, the `TREMOR` home link, or `#network`.
- The header's `I felt it` button (any screen) and the relay count (`relay-status`).
- `?relays=wss://a,wss://b` before the hash.

## Driving it with drive.mjs

Preconditions: the baseline. `const { scenarioEvents, send } = await app('/tests/e2e/publish.ts')` and `const napa = scenarioEvents('napa-2014')`, which ends the Napa quake 80 s ago. For `net-confirmed`, add USGS's own record before opening: `usgs([{ id: 'nc-replayed', mag: 6, place: '6 km NW of American Canyon, CA', time: napa.sim.origin, lat: 38.215, lon: -122.312, depth: 11 }])`. Felt reports and extra phones come from `app('/src/net/protocol.ts')` (`signFelt`, `signHeartbeat`, `signPick`, `signTrigger`, `signRetraction`) with fresh keys from `nostr-tools/pure`'s `generateSecretKey`.

- **Near you, typed (`net-near`).** `open('#network')`. In `near`, fill `Or type latitude, longitude` with `38.7` and press `Set`: the status says `Type a latitude and a longitude…` and the box is `aria-invalid`. Fill `38.7, -122.7` and press `Set`: `Near 38.70°N 122.70°W`, `change` takes focus, `tremor.location` is `{ lat: 38.7, lon: -122.7 }`, and the `near-item`s run nearest first, each with `km from you`.
- **Near you, browser location (`net-near`).** `page.context().grantPermissions(['geolocation'])` and `setGeolocation(...)` before pressing `change`, then `Use my approximate location`: the card follows. Reload: the card keeps it. With `tremor.join` set to `1` and a reload, `change` is gone and `change it under Be a sensor` links to `#sensor`.
- **Phones (`net-phones`).** `relay-status` reads `1/1 relays`, `no-events` shows. `send(relay.url, napa.heartbeats)`: `stat-nodes` reads their count.
- **Provisional (`net-provisional`).** `send(relay.url, napa.picks)`: `provisional` shows and contains `± N km`, and `getByRole('alert')` contains `Provisional earthquake detection`. For the withdrawn path, publish four nearby phones' heartbeats and picks, then a `footsteps` retraction from each: `outcome` reads `Not confirmed: 4 of 4 phones withdrew (footsteps…`.
- **Confirmed (`net-confirmed`).** `send(relay.url, napa.finals)`: `stat-events` reads `1`, the provisional card goes, `outcome` starts `Confirmed: M`, `event-list` contains `Matches USGS`. Press the event's button: `compare` shows `est-loc` within about 15 km of Napa, `est-km` reading `± N km` with the USGS epicentre within N km, `est-mag` reading a range that holds 6.0, a note starting `In tests on simulated quakes, nine times in ten`, and a `verdict` starting `Off by`. The map shows a dashed ring labelled `± N km`.
- **Felt (`net-felt`).** With a location set, press the banner's `I felt it`: dialog `I felt it` with five buttons in `How strong was the shaking where you are?`. Press `light…`: the status says `You reported light shaking at`, and `relay.events()` holds one kind-4580 event with `lvl: 2` and the location to 0.01°. Close, press the card's `I felt it`: `You can report again from` and no new event. The same holds with site storage blocked (`addInitScript` making `localStorage` throw). Publish three reports from fresh keys 4 km apart: one `felt` row, `3 people in 3 places felt shaking`. Twelve from one key in twelve places: no row.
- **Chime (`net-chime`).** Before `open`, replace `AudioContext`, `Notification` and `navigator.vibrate` with counters (`addInitScript`), as `tests/e2e/network.spec.ts` does. Set a location, tick `Chime when shaking is confirmed near me`. Picks that are then withdrawn: no tone. Four phones within 100 km confirm a quake: one tone, one buzz, one notification, and an alert `Shaking reported near you. Not an official warning.` with `Dismiss`. People then report the same shaking, or very strong shaking elsewhere nearby: still one. A USGS quake that shook here 40 minutes ago: still one; one 12 minutes ago (`past hour`/`past day` refetches the feed): two.
- **USGS (`net-usgs`).** `usgs-list` has one `li` per row of the feed, nearest first once a location is set; `worldwide` reorders it. Press `past hour`: the button is pressed and the list follows the shorter feed. With `page.route` answering the feed with `garbage`, the screen says `The USGS feed could not be reached`.
- **Hostile (`net-hostile`).** Send a heartbeat whose content was edited after signing and one with an invalid signature: `stat-nodes` does not count them and no console error appears.
- **Relays (`net-relays`).** Open `details.relays`. Type `relay.damus.io` and `wss://nos.lol` in `Relay URLs, one per line` and press `Save and reconnect`: a status names `relay.damus.io`, the box is `aria-invalid`, nothing is saved. With two `wss://` lines the page reloads with both in `tremor.relays`. For no relay at all, `page.goto` the served URL with `?relays=wss://relay.one.example#network` (`open` would put the private relay first): `0/1 relays` and a status `Not connected to any relay…`, never "all quiet".
- **Offline map (`net-offline-map`).** Any isolated run: the `Offline basemap` note shows and the map still draws.

## Gotchas

- Events from a phone whose heartbeat has not arrived wait until it does; send heartbeats first or in the same batch.
- The screen recomputes 200 ms after a batch arrives; wait on the counts, not on time.
- `scenarioEvents` dates the quake from the moment it is called; open the screen within a minute or two, or the provisional window (5 min for picks) passes. Near-you lists Tremor detections for 10 minutes only.
- The chime counts only shaking that arrives after the box is ticked, and the tick is not saved across reloads: a page can start sound only from a tap.
- A `?relays=` link wins over the saved list until the list is saved again from the editor.
- Mocks used here, beyond the baseline: the browser's geolocation (`net-near`), and the speaker, vibration and notifications (`net-chime`). Name them in the proof.
