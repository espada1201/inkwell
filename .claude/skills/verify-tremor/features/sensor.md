# Be a sensor

Be a sensor turns this phone into a seismometer. After the reader starts it, it learns the background shaking, then picks the onset of anything stronger and publishes the pick at once (only if the reader opted in and set a location). It checks the shaking for 15 to 30 s against the background from before it began, and either confirms it with its peak or withdraws it with a reason. A word meter, a live trace, a log and the state line show what it is doing, a card says what this phone can feel, and a computer without motion sensors and a refused permission each say so.

## Sub-features

- `sensor-start` asks for motion access where the browser requires it, warms up while it learns the background, then listens; Start hands focus to Stop.
- `sensor-optin` publishes nothing until sharing is on and a location is set (typed, or the browser's); the location is snapped to 0.01°.
- `sensor-background` shows the background the detector judges by, in mm/s², once warm-up ends, and a meter word: `Quiet`, `Something moving` or `Shaking`.
- `sensor-pick` publishes a pick about a second after the shaking reaches the phone, with the wave it felt (P or S).
- `sensor-verdict` confirms a quake-like shake 15 to 30 s after its onset as a trigger linked to its pick (`Confirmed shaking: moderate, 0.43 m/s² · P wave · sent`), or withdraws a knock, footsteps or a moved phone with its reason. Stopping, hiding the tab or switching sharing off withdraws a pick still being checked at once (switched off, the phone goes on checking it for its own log).
- `sensor-heartbeat` announces the phone to the network from the end of warm-up, and says it stopped (sps 0) before sharing is switched off.
- `sensor-can-feel` says how far away this phone would notice an M4 and an M5, how long it has listened this session and this week, how many other phones listen within 25 km, and which recent USGS quakes it felt, missed, or was too far from.
- `sensor-states` explains a refused permission and a device with no motion data.
- `sensor-keyboard` keeps focus and typed coordinates while the screen redraws.

## How to get to it (user POV)

- The `Be a sensor` tab, or `#sensor`.
- `Start` (`data-testid="start"`, then `Stop sensor`), the `Latitude` and `Longitude` boxes with `Set`, `Use my approximate location`, and the `Share with the Tremor network` checkbox.

## Driving it with drive.mjs

Preconditions: the baseline. Motion comes in as DeviceMotion events, as a phone's browser delivers them: before `open`, `page.addInitScript(() => (DeviceMotionEvent.requestPermission = async () => 'granted'))` (iOS asks), and after `Start` dispatch `devicemotion` events at 50 Hz from a record made by `(await app('/src/core/synth.ts')).synthesize({ start: 0, durationS: 34, seed: 3, quake: { tP: 10, tS: 13, pga: 0.8 } })`, paced as `tests/e2e/sensor.spec.ts`'s `feed()` does. Keep the wall-clock time the feed started: the quake's P wave reaches the phone 10 s later.

- **Opt in (`sensor-optin`).** `open('#sensor')`: `sensor-state` reads `Ready`, `publish-note` contains `Nothing leaves this phone`. Fill `Latitude` 37.77493 and `Longitude` −122.41942, press `Set`: `loc` reads `37.77°N 122.42°W`. Check `Share with the Tremor network`: `publish-note` contains `On.`
- **Listen (`sensor-start`, `sensor-background`).** Press `Start` and feed the record: `Stop sensor` takes focus, `sensor-state` reads `Listening` within 10 s, `background` reads 10 to 15 mm/s², `meter-word` reads `Quiet`, and the `canvas.trace` gets drawn.
- **Pick (`sensor-pick`).** Within 20 s `relay.events()` holds one kind-4578 pick whose content has `ph: "P"` and an onset `t` 0 to 1 s after the P wave; `meter-word` reads `Shaking`.
- **Verdict (`sensor-verdict`).** Within 40 s `sensor-log` contains `Confirmed shaking: … m/s² · P wave · sent`, 15 to 31 s after the onset, and the kind-4579 trigger has the pick's id in an `e` tag and `pga` above 0.3. For a withdrawal, press `Stop sensor` while a pick is being checked: the log says `stopped before the check finished`, and a kind-5 retraction of the pick, then a heartbeat with `sps: 0`, reach the relay.
- **Heartbeat and privacy (`sensor-heartbeat`, `sensor-optin`).** The kind-34579 heartbeat's content has `lat: 37.77, lon: -122.42, sps: 50`; nothing published carries more than two decimals. Uncheck sharing: a last heartbeat with `sps: 0` goes out first.
- **Nothing before opt-in (`sensor-optin`).** In a fresh run press `Start` and feed 8 s of quiet: `Listening`, and `relay-events.json` is `[]`.
- **What it can feel (`sensor-can-feel`).** Before a location, `can-feel` says to set one. Set 37.77, −122.42: `neighbours` reads `No other phones heard listening within 25 km.` Publish heartbeats from fresh keys at 37.8, −122.27 and 37.7, −122.47, one at 37.75, −122.4 with `sps: 0`, and one in Sacramento: `Heard from 2 other phones listening within 25 km.` Start and listen: `reach` reads `Would notice an M4 within about 50 km and an M5 within about 90 km.`, and the listening time reads `under a minute`.
- **Keyboard (`sensor-keyboard`).** Tab from `Start` through sharing, `Use my approximate location`, `Latitude` (type 37.77), `Longitude` (type −122.42) to `Set` and press Enter: `loc` reads `37.77°N 122.42°W` and `Set` keeps focus.
- **States (`sensor-states`).** With `requestPermission` answering `'denied'`, `Start` gives `Motion access denied`. With no events fed, `Warming up` turns into `No motion data` within 8 s.

## Gotchas

- The detector runs on real time: feed events with timers paced to 20 ms, not in one burst.
- Opting in needs both the checkbox and a location; either alone publishes nothing.
- The background, the reach and the first heartbeat wait for warm-up; before it the screen says `learning…`.
- `--phone` changes the viewport, not the sensors: motion is fed the same way.
