import type { Trigger } from './associate';
import type { Listener } from './early';
import { offset, type LatLon } from './geo';
import { gauss } from './rng';
import type { DetectorOutput } from './sensor';

/** Samples per second of every simulated phone record. */
export const FS = 50;
/** Spread of simulated phones' clock errors, ms (one standard deviation). */
export const CLOCK_SIGMA_MS = 150;
/** A phone's own accelerometer noise, m/s² RMS per axis: phones differ. */
export const phoneNoise = (r: () => number) => 0.008 + 0.01 * r();
/** How much harder or softer a phone's own spot shakes than the attenuation law says. */
export const siteScatter = (r: () => number) => 10 ** (0.15 * gauss(r));
/** Seconds the strong shaking takes to die away: bigger quakes ring longer. */
export const codaS = (mag: number) => 2 + mag - 4;

/** A point drawn evenly over the disk of `radiusKm` around `c`. */
export function pointInDisk(c: LatLon, radiusKm: number, r: () => number): LatLon {
  const a = r() * 2 * Math.PI;
  const d = radiusKm * Math.sqrt(r());
  return offset(c, d * Math.cos(a), d * Math.sin(a));
}

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
