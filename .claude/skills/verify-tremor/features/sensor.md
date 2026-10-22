# Be a sensor

Be a sensor turns this phone into a seismometer. After the reader starts it, it learns the background shaking, then picks the onset of anything stronger, publishes the pick at once (only if the reader opted in and set a location), checks it for 15 to 30 s and either confirms it with its peak shaking or withdraws it with a reason. A live trace, a log and the state line show what it is doing; a computer without motion sensors and a refused permission each say so.

## Sub-features

- `sensor-start` asks for motion access where the browser requires it, warms up, then listens.
- `sensor-optin` publishes nothing until sharing is on and a location is set; the location is snapped to 0.01°.
- `sensor-pick` publishes a pick within moments of a strong onset, with the wave it felt (P or S).
- `sensor-verdict` confirms a quake-like shake as a trigger linked to its pick, or withdraws a knock, footsteps or a moved phone with its reason.
- `sensor-heartbeat` announces the phone to the network while it listens, and says when it stopped.
- `sensor-states` explains a refused permission and a device with no motion data.

## How to get to it (user POV)

- The `Be a sensor` tab, or `#sensor`.
- `Start` (`data-testid="start"`), the `Latitude` and `Longitude` boxes with `Set`, and the `Share with the Tremor network` checkbox.

## Driving it with drive.mjs

Preconditions: the baseline. Motion comes in as DeviceMotion events, as a phone's browser delivers them: before `open`, `page.addInitScript(() => (DeviceMotionEvent.requestPermission = async () => 'granted'))` (iOS asks), and after `Start` dispatch `devicemotion` events at 50 Hz from a record made by `(await app('/src/core/synth.ts')).synthesize({ start: 0, durationS: 34, seed: 3, quake: { tP: 10, tS: 13, pga: 0.8 } })`, as `tests/e2e/sensor.spec.ts`'s `feed()` does.

- **Opt in (`sensor-optin`).** `open('#sensor')`: `sensor-state` reads `Ready`, `publish-note` contains `Nothing leaves this phone`. Fill `Latitude` 37.77493 and `Longitude` −122.41942, press `Set`: `loc` reads `37.77°N 122.42°W`. Check `Share with the Tremor network`: `publish-note` contains `On.`
- **Listen and pick (`sensor-start`, `sensor-pick`).** Press `Start` and feed the record: `sensor-state` reads `Listening` within 10 s, the `canvas.trace` gets drawn, and within 20 s `relay.events()` holds one kind-4578 pick whose content has `ph: "P"`.
- **Verdict (`sensor-verdict`).** Within 40 s `sensor-log` contains `TRIGGER … m/s² · P wave · sent`, and the kind-4579 trigger has the pick's id in an `e` tag and `pga` above 0.3.
- **Heartbeat and privacy (`sensor-heartbeat`, `sensor-optin`).** The kind-34579 heartbeat's content has `lat: 37.77, lon: -122.42, sps: 50`; nothing published carries more than two decimals.
- **Nothing before opt-in (`sensor-optin`).** In a fresh run press `Start` and feed 8 s of quiet: `Listening`, and `relay-events.json` is `[]`.
- **States (`sensor-states`).** With `requestPermission` answering `'denied'`, `Start` gives `Motion access denied`. With no events fed, `Warming up` turns into `No motion data` within 8 s.

## Gotchas

- The detector runs on real time: feed events with timers paced to 20 ms, not in one burst.
- Opting in needs both the checkbox and a location; either alone publishes nothing.
- `--phone` changes the viewport, not the sensors: motion is fed the same way.
