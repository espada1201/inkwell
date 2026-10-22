---
name: verify-convergence
description: Check that every browser watching the same relays shows the same Tremor network, whatever order the events arrive in. Use before changing how src/app/live.ts takes in heartbeats, picks, triggers, retractions or felt reports, how src/core/associate.ts orders triggers, or how src/core/felt.ts groups reports.
---

# Verify convergence

**Property.** Feed the live network the same events in any order, and it shows the same phones, picks, triggers, confirmed and provisional quakes, felt reports and felt shakings.

**Harm when it breaks.** Relays deliver events in any order, so two people watching the same quake would see different phones in it, a different shaking level, or a footstep that its phone withdrew.

**How it is checked.** No verifier runs on TypeScript, so the check runs the real code on every order of a few events, within the bounds below. Each scenario signs and parses its events once, then gives them to `LiveNetwork.receive` in every order (720 orders of 6) on a fake clock that moves 250 ms after each one, so the recompute each event queues runs before the next arrives, and compares what a reader can see after the last. The check never recomputes by itself: an event that changes what the network shows but queues no recompute leaves the orders that end with it looking different. Tied onsets are checked in the association itself, on every order of six triggers.

```sh
npx vitest run tests/unit/converge.test.ts tests/unit/associate.test.ts
```

It takes about two seconds. A failure lists every order whose network differs from the first order's.

## Coverage

Last confirmed to describe the code at commit `f67ce52`.

| Check | Code it covers |
| --- | --- |
| `converge.test.ts`: retractions by their author or a forger | `LiveNetwork.receive`: the heartbeat branch and its replay of held messages, held messages from unannounced keys, `retract`, `pick` |
| `converge.test.ts`: confirmed quake with triggers, repeats and an older heartbeat | `receive`: `heartbeat` (older one ignored), `trigger` (repeat ignored); `recompute` → `confirmedEvents` |
| `converge.test.ts`: provisional quake with withdrawals and repeats | `receive`: `pick`, `retract`; `recompute` → `earlyDetect`, `unconfirmed` |
| `converge.test.ts`: no provisional quake where quiet phones are heard before the picks or after | `receive`: `heartbeat` queues a recompute; `recompute` → `earlyDetect` and the quiet phones' veto (`verdict` in `src/core/early.ts`) |
| `converge.test.ts`: felt reports, one key twice in ten minutes | `receive`: `felt`; `clusterFelt` in `src/core/felt.ts` |
| `associate.test.ts`: "finds the same quakes whatever order…" | `associate` and its `byOnset` order in `src/core/associate.ts` |

The compared view is `seen()` in `converge.test.ts`: each phone's place, rate, last heartbeat, last trigger and whether it counts as listening at every event's time; the ids of picks, triggers and felt reports; each quake's members, place, time and magnitude; each shaking's reports, level, time and place.

## Bounds and assumptions

- At most six events are reordered per scenario, after a fixed prefix. Every collection stays far below its cap.
- One fake clock, set back to the scenario's start for each order. It moves 250 ms after every event, prefix included, which is past the 200 ms batch, so no two events share a recompute and every order ends at the same time. Nothing is pruned.
- Every scenario stays well inside its time limits throughout (picks under a minute old, quiet phones long due, nothing near the two minutes a detection waits), so a last event that rightly queues nothing, like a repeat, leaves the same view as one that does.
- Heartbeats carry `since`, as Tremor's own do.

Not covered, on purpose: past a cap the oldest arrival is dropped, and past 30 picks an hour a phone's first ones win, so both depend on order by design. The history of provisional detections (`provisional`) records when this browser saw things. A heartbeat without `since` falls back to when it arrived. `parse`, the relay pool's de-duplication, USGS, and which confirmed event explains a provisional one by the picks its triggers name (`explainedBy`, decided afresh from what has arrived at each recompute) are covered by their own tests.

## When it fails

1. Take the first order the failure lists, and the first order of that scenario (the events as written).
2. In a scratch test, give a fresh `LiveNetwork` the scenario's prefix, then each order, on the fake clock as `divergences` does, and print `seen()` for both. The fields that differ name the branch. When every order that differs ends with the same kind of event, that event's branch may change what the network shows without queueing a recompute.
3. Relays can deliver any order, so a difference in the compared view is a bug in the code. It is an error in the check only when the field should not be compared: then fix `seen()`, and say why in the commit.

Never shrink a scenario or drop a field to make the check pass.

## After a change to covered code

- New message type or branch in `receive`: add it to a scenario, or add a scenario. Keep each at six reordered events: seven is 5,040 orders.
- Show the check can still fail: break the new rule in a scratch worktree (`git worktree add --detach <dir> HEAD`). Breaks that it caught at the commit under Coverage: deleting `if (p && p.node !== m.node) return;` or `if (this.withdrawals.has(…)) return;` in `receive` fails two scenarios each; deleting the heartbeat branch's `this.queueRecompute()` fails the quiet-phones scenario, in the 48 orders that hear both quiet phones after the last pick; sorting by `a.t - b.t` instead of `byOnset` fails the association check; counting a key's first-arriving felt report fails the felt scenario.
- Move the commit under Coverage forward only after the check passes and you have confirmed this file still describes the code at the new commit.
