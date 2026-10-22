# Network

The Network screen watches the relays this browser follows. It counts the phones listening, turns their picks into a provisional detection within seconds, turns their vetted triggers into a confirmed, located quake with a magnitude, and checks each confirmed quake against the USGS feed, which it also lists. Forged or malformed events are ignored, and the relays in use can be changed.

## Sub-features

- `net-phones` counts phones from their heartbeats; a phone that stopped or went quiet stops counting.
- `net-provisional` shows a provisional detection, as an alert, from raw picks that fit one wavefront, before any phone has vetted its shaking.
- `net-confirmed` lists a confirmed quake from vetted triggers, located, sized and marked `Matches USGS` when the feed has it; selecting it shows the comparison.
- `net-usgs` lists the USGS feed for the past day or hour, with loading and calm error states.
- `net-hostile` drops forged and malformed events without breaking the page.
- `net-relays` shows how many relays are open and lets the reader edit the list, which survives a reload.
- `net-offline-map` falls back to a bundled coastline when map tiles cannot load.

## How to get to it (user POV)

- The `Network` tab, the `TREMOR` home link, or `#network`.
- The relay count in the header (`relay-status`).
- `?relays=wss://a,wss://b` before the hash.

## Driving it with drive.mjs

Preconditions: the baseline. `const { scenarioEvents, send } = await app('/tests/e2e/publish.ts')` and `const napa = scenarioEvents('napa-2014')`, which ends the Napa quake 80 s ago. For `net-confirmed`, add USGS's own record before opening: `usgs([{ id: 'nc-replayed', mag: 6, place: '6 km NW of American Canyon, CA', time: napa.sim.origin, lat: 38.215, lon: -122.312, depth: 11 }])`.

- **Phones (`net-phones`).** `open('#network')`; `relay-status` reads `1/1 relays`, `no-events` shows. `send(relay.url, napa.heartbeats)`: `stat-nodes` reads their count.
- **Provisional (`net-provisional`).** `send(relay.url, napa.picks)`: `provisional` shows and `getByRole('alert')` contains `Provisional earthquake detection`.
- **Confirmed (`net-confirmed`).** `send(relay.url, napa.finals)`: `stat-events` reads `1`, the provisional card goes, `event-list` contains `Matches USGS`. Press the event's button: `compare` shows `est-loc` within about 15 km of Napa and a `verdict` starting `Off by`.
- **USGS (`net-usgs`).** `usgs-list` has one `li` per row of the feed. Press `past hour`: the button is pressed and the list follows the shorter feed. With `page.route` answering the feed with `garbage`, the screen says `The USGS feed could not be reached`.
- **Hostile (`net-hostile`).** Send a heartbeat whose content was edited after signing and one with an invalid signature: `stat-nodes` does not count them and no console error appears.
- **Relays (`net-relays`).** Add a second `ws://` URL in `Relay URLs, one per line` and press `Save and reconnect`: the page reloads with both in `tremor.relays` and the header counts both.
- **Offline map (`net-offline-map`).** Any isolated run: the `Offline basemap` note shows and the map still draws.

## Gotchas

- Events from a phone whose heartbeat has not arrived wait until it does; send heartbeats first.
- The screen recomputes 200 ms after a batch arrives; wait on the counts, not on time.
- `scenarioEvents` dates the quake from the moment it is called; open the screen within a minute or two, or the provisional window (5 min for picks) passes.
- A `?relays=` link wins over the saved list until the list is saved again from the editor.
