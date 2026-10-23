# Tremor verification map

This is the maintained list of what a Tremor user can do, one file per screen. Read this index, then drive the matching file's recipes with `drive.mjs` (see `../SKILL.md`).

## Baseline preconditions

- Tremor is served from this checkout (`npm start`, or your own `vite preview` port) and the doctor passes.
- A fresh browser profile: `drive.mjs` starts each journey with empty localStorage, so there is no saved location, relay list, identity or opt-in.
- Isolated runs use one private relay and no map tiles, with the default two-quake USGS feed unless the recipe sets one.
- Replays play at `speed=10` unless a recipe says otherwise; at 1× a quake takes a minute or more.

## Driving conventions

- Start every recipe from the baseline. A recipe that needs a saved location sets it through the sensor screen's form, as a user does.
- Prefer roles and accessible names, then `data-testid`. The tabs are links in the `Sections` navigation. The first Tab stop on every screen is `Skip to content`, which focuses the screen's heading (on Be a sensor, its Start/Stop button); opening a tab by keyboard lands there too (by tap, focus moves without scrolling), and the map canvas and its zoom buttons show the same focus ring as everything else. On a touch screen one finger scrolls the page over the map; two move the map, and on a phone width the tabs are a bar fixed to the bottom of the screen, so they stay in reach however far the page is scrolled.
- Wait on visible state (a heading, a status line, a count), never on fixed sleeps: the network recomputes 200 ms after each batch of messages and the planner runs in a worker for several seconds.
- Read numbers off the page with `innerText` and note them; a proof quotes what a user would read.

## Proof and skip reporting

- Screenshots of the state before and after each action, and an ARIA snapshot of the panel at the end.
- Network proofs include `relay-events.json`; sensor proofs include the events the phone published.
- Report each sub-feature ID as PASS, FAIL (what was expected and what was seen) or NOT VERIFIED (what was missing).

## Feature entry contract

Each file opens with what the screen does for a user, then four sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.mjs` (preconditions, then labelled steps with the exact handle and the result to see), `Gotchas`.

## Features

- [Network](./network.md): shaking near you, live phones, provisional and confirmed detections, felt reports, the opt-in chime, the USGS cross-check, relays.
- [Replay](./replay.md): historical quakes and recent USGS quakes played into simulated phones.
- [Plan](./plan.md): how many phones a city, or the reader's own area, needs.
- [Be a sensor](./sensor.md): turning this device into a seismometer that publishes picks and triggers, and what it can feel.
- [About](./about.md): what Tremor claims, which must match what the other screens do.
