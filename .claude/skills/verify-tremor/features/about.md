# About

About explains, in five steps, how a phone becomes part of the network (feel, tell at once, doubt, agree, check), what Tremor is not, how it treats privacy and what goes over the wire. Every sentence is a claim about the other screens and the published events, so verifying About means checking each claim against what the app does.

## Sub-features

- `about-steps` describes detection, the pick, the on-device checks, the network's agreement rule and the USGS check.
- `about-limits` says what Tremor is not: no official warnings, strong shaking only, rough magnitudes, open relays.
- `about-privacy` says nothing leaves before opt-in and a location, locations are snapped to 0.01°, and the key stays in the browser.
- `about-protocol` names the event kinds and the `#tremor` tag.

## How to get to it (user POV)

- The `About` tab, or `#about`.

## Driving it with drive.mjs

Preconditions: the baseline.

- **Read it.** `open('#about')`; heading `Old phones as civic infrastructure`; `aria('about', page.locator('aside.panel'))` keeps the text that is being checked.
- **Pick timing (`about-steps`).** Drive `features/sensor.md`'s publish recipe and compare the pick's `created_at` with the onset `t` in its content: the gap must fit what step 2 says.
- **Agreement rule (`about-steps`).** The rule in step 4 is the one the unit tests in `tests/unit/early.test.ts` pin; quote the passing test names as evidence, and check the Replay and Network screens state the same rule.
- **Privacy (`about-privacy`).** In a fresh profile on `#sensor`, press `Start` without opting in and feed motion: `relay-events.json` stays empty. Opt in with a location: every published event's `lat`/`lon` has at most two decimals.
- **Protocol (`about-protocol`).** In `relay-events.json` from the sensor recipe, the kinds are 34579, 4578 and 4579 (and 5 for a retraction), each tagged `["t","tremor"]`.

## Gotchas

- A claim the code does not back is a FAIL of `about-*`, not of the screen it describes: report the sentence and what the app does instead.
- README makes the same claims more briefly; check both in the same run.
