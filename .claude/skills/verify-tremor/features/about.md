# About

About explains, in five steps, how a phone becomes part of the network (feel, tell at once, doubt, agree, check), what Tremor is not, who tried this before, how it treats privacy and what goes over the wire. Every sentence is a claim about the other screens and the published events, so verifying About means checking each claim against what the app does.

## Sub-features

- `about-steps` describes detection, the pick about a second after the shaking arrives, the on-device checks against the background from before it, the network's agreement rule with how far off a location could be, and the USGS check with its M4.5 limit outside the US.
- `about-limits` says what Tremor is not: no official warnings (and where to turn them on instead), fairly strong shaking only, rough magnitudes that read low for big quakes, a sensor or chime only while the page stays open, and open relays where phones, picks and felt reports can be faked. It names who came first: the Quake-Catcher Network, MyShake and Android's Earthquake Alerts.
- `about-privacy` says nothing is sent before the reader opts in and sets a location, or reports shaking they felt. It says every location is snapped to 0.01°, a felt report's too, and that the key stays in the browser.
- `about-protocol` names the event kinds and the `#tremor` tag, and links to the code.

## How to get to it (user POV)

- The `About` tab, or `#about`.

## Driving it with drive.mjs

Preconditions: the baseline.

- **Read it.** `open('#about')` shows the heading `Old phones as civic infrastructure`, and `aria('about', page.locator('aside.panel'))` keeps the text that is being checked.
- **Pick timing (`about-steps`).** Drive `features/sensor.md`'s publish recipe and compare the pick's `created_at` with the onset `t` in its content: the gap must fit what step 2 says.
- **Agreement rule (`about-steps`).** The rule in step 4 is the one the unit tests in `tests/unit/early.test.ts` pin; quote the passing test names as evidence, and check the Replay and Network screens state the same rule.
- **Privacy (`about-privacy`).** In a fresh profile on `#sensor`, press `Start` without opting in and feed motion: `relay-events.json` stays empty. Opt in with a location: every published event's `lat`/`lon` has at most two decimals.
- **Limits (`about-limits`).** A headless browser cannot hide its tab, so the open-on-screen claim rests on the unit test `withdraws a pick still being checked as soon as the tab is hidden` in `tests/unit/sensor.test.ts`: quote it, and report the browser path NOT VERIFIED. The prior-art sentence is a claim about the world, not the app: report it as checked against sources, or NOT VERIFIED.
- **Protocol (`about-protocol`).** In `relay-events.json` from the sensor recipe, the kinds are 34579, 4578 and 4579 (and 5 for a retraction), and a felt report from the Network recipe is 4580, each tagged `["t","tremor"]`. The `The code is open too` link points at the repository.

## Gotchas

- A claim the code does not back is a FAIL of `about-*`, not of the screen it describes: report the sentence and what the app does instead.
- The README makes the same claims more briefly; check both in the same run.
