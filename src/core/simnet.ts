import type { Trigger } from './associate';
import type { Listener } from './early';
import type { DetectorOutput } from './sensor';

/**
 * The simulated network that Replay and the planner share: how long the relays take, and what a
 * browser watching them receives from each simulated phone.
 */

/** Assumed phone → relay → browser latency, ms; an alert takes as long back out to the phones. */
export const RELAY_LATENCY_MS = 1000;

/** Seconds after the origin that an alert declared at `declaredS` reaches the phones. */
export const alertS = (declaredS: number) => declaredS + RELAY_LATENCY_MS / 1000;

/** One message as a browser watching the relays receives it. */
export interface Arrival {
  /** ms on the same clock as `from` in `arrivalsOf`. */
  at: number;
  kind: 'pick' | 'retract' | 'trigger';
  tr: Trigger;
}

/** What a browser receives from one phone's detector outputs, timed from `from` (ms). */
export function arrivalsOf(node: Listener, outputs: DetectorOutput[], from = 0): Arrival[] {
  return outputs.map((o) => ({
    at: o.at - from + RELAY_LATENCY_MS,
    kind: o.kind === 'reject' ? 'retract' : o.kind,
    tr: { id: `${node.id}@${o.t}`, node: node.id, lat: node.lat, lon: node.lon, t: o.t, pga: o.kind === 'trigger' ? o.pga : 0, phase: o.kind === 'reject' ? undefined : o.phase },
  }));
}
