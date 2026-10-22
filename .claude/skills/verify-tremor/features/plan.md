# Plan

Plan answers "how many phones would my city need?". It simulates 24 quakes of the chosen size and setting on the chosen number of phones, through the real network code, and reports how many were detected, how soon the first alert reached phones, how many shaken people were warned in time, how far off the locations were and how many false alarms a busy hour of jostled phones caused. A curve shows the same for 10 to 1,000 phones. "Here" plans for the reader's own area and sets the phones listening there now beside the number that would be enough.

## Sub-features

- `plan-city` runs a plan for one of six cities, keeping the choice in the address.
- `plan-knobs` changes magnitude (`M5`–`M7`), setting (`Directly beneath`, `Nearby fault`, `Far away`) and phones (slider, keyboard).
- `plan-kpis` shows detected `n/24`, first alert at the phones, shaken area warned in time, location error and false alarms `n/60`, with a story sentence that matches them.
- `plan-curve` draws the sweep, point by point, as the worker finishes each network size.
- `plan-here` plans within 20 km of the saved location or a typed `lat, lon`, follows the phones listening there now until the reader picks a count, and links to the count that would catch the quake 9 times in 10.
- `plan-link` reopens a plan from `#plan/<city or lat,lon>/<mag>/<setting>/<phones>`; nonsense parts fall back to defaults.

## How to get to it (user POV)

- The `Plan` tab.
- A place button in the `Place` group (`data-city="istanbul"`, `kathmandu`, `lima`, `manila`, `mexico-city`, `bay-area`, and `here`).
- An address such as `#plan/kathmandu/6/near/50` or `#plan/37.8,-122.27/6/under/25`.

## Driving it with drive.mjs

Preconditions: the baseline. Each run takes several seconds in a worker; allow 30–60 s per wait.

- **City (`plan-city`, `plan-kpis`).** `open('#plan/kathmandu/6/near/50')`. Heading `Plan a network`; `data-city="kathmandu"` pressed; `getByTestId('kpi-detected')` reads `n/24`, `kpi-alert` a time or `—`, `kpi-warned` a share, `kpi-false` `n/60`; `.plan-story` starts `With 50 phones listening across Kathmandu`.
- **Knobs (`plan-knobs`).** Press `M7`: the address ends `#plan/kathmandu/7/near/50` and the story mentions M7. Focus slider `Phones listening`, press `ArrowRight`: `output` reads `75 phones`, its `aria-valuetext` too, and the address ends `/75`.
- **Curve (`plan-curve`).** `getByTestId('sweep')` gains `circle`s as sizes finish; `plan-status` ends `Done: 24 quakes and a busy hour per network size.`
- **Here, saved location (`plan-here`).** Save a location on the sensor screen (`Latitude` 37.8, `Longitude` −122.27, `Set`), then press `data-city="here"`: the address becomes `#plan/37.8,-122.27/…` and `plan-gap` reads `Right now no phones listen within 20 km of you; about N would catch …`. Publish three heartbeats within 20 km and one 60 km away (`app('/src/net/protocol.ts').signHeartbeat` with fresh keys, `send` from `/tests/e2e/publish.ts`): the gap line and `output` follow to `3 phones`. Press the gap's link: `output` reads the target count and the address matches the link.
- **Here, typed (`plan-here`).** From a fresh profile press `here`: the `Latitude, longitude` box takes focus with `Type coordinates, or save your location under Be a sensor.` Type `95, 10` and Enter: the range message shows and `here` stays unpressed. Type `27.7 85.32` and press `Plan here`: the address ends `#plan/27.7,85.32/6/…`.
- **Link (`plan-link`).** `open('#plan/x/6/toString/200')` opens the first city with defaults and no console error.

## Gotchas

- A new choice cancels the running simulation; wait for the story to mention the new choice, not just for a number to appear.
- "First alert" is when phones get the alert, a relay hop after the network declares; it matches Replay's timeline, not the declaration time.
- Here counts only phones heard from in the last few minutes; a heartbeat older than three minutes no longer counts.
- A Here link carries the spot to 0.01°, about a kilometre: the reader's own coarse location when it came from the saved one.
