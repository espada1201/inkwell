import type { DetectedEvent, Trigger } from '../core/associate';
import { confirmedEvents, earlyDetect, unconfirmed, type EarlyEvent, type Onset } from '../core/early';
import { HEARTBEAT_EVERY_MS } from '../net/protocol';

export const NODE_STALE_MS = 3 * HEARTBEAT_EVERY_MS;

export interface ModelNode {
  id: string;
  lat: number;
  lon: number;
  sps: number;
  since?: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Whether a phone was listening at time t: it had started by then, and was heard from after
 * it, or shortly before without saying it had stopped.
 */
export function isOnline(n: ModelNode, t: number) {
  if ((n.since ?? n.firstSeen) > t) return false;
  return n.lastSeen >= t || (n.sps > 0 && t - n.lastSeen < NODE_STALE_MS);
}

export interface ModelInput {
  now: number;
  nodes: ModelNode[];
  picks: Trigger[];
  triggers: Trigger[];
  heard: Onset[];
}

export interface ModelOutput {
  events: DetectedEvent[];
  early: EarlyEvent[];
  waiting: boolean;
}

export function computeModel({ now, nodes, picks, triggers, heard }: ModelInput): ModelOutput {
  const events = confirmedEvents(triggers, heard, (t) => nodes.filter((n) => isOnline(n, t)), now);
  const early = earlyDetect(picks, nodes.filter((n) => isOnline(n, now)), now);
  return { events, early: unconfirmed(early.events, events), waiting: early.waiting };
}

export interface ModelDelta {
  now: number;
  setNodes: ModelNode[];
  dropNodes: string[];
  addPicks: Trigger[];
  dropPicks: string[];
  addTriggers: Trigger[];
  dropTriggers: string[];
  heard: { all: Onset[] } | { add: Onset[] };
}

/** What works the model out: here on the page, answering at once, or beside it, answering later. */
export type Compute = ((delta: ModelDelta) => ModelOutput | Promise<ModelOutput>) & {
  /** Let go of what it holds (a worker): called when the page stops using it. */
  dispose?: () => void;
};

/** The model on the page itself: the same deltas as the worker gets, the same `computeModel`, so the two cannot differ in what they are given. */
export function mainThread(): Compute {
  const mirror = new ModelMirror();
  return (delta) => computeModel(mirror.apply(delta));
}

const slim = ({ id, lat, lon, sps, since, firstSeen, lastSeen }: ModelNode): ModelNode => ({ id, lat, lon, sps, since, firstSeen, lastSeen });

/**
 * What the other side holds of one ordered, keyed collection, and what to tell it so it holds
 * the page's, in the page's order. A thing the page has replaced by a new object with the same
 * key is sent again. The other side puts what it is sent anew last and leaves the rest in
 * place, so where the page's order differs from that (a thing dropped and back since the last
 * delta now sits after what came in meanwhile), the things from the first difference on are
 * dropped and sent again.
 */
class Held<T> {
  private by = new Map<string, T>();

  constructor(private readonly keyOf: (t: T) => string) {}

  diff(page: Iterable<T>): { drop: string[]; set: T[] } {
    const next = new Map<string, T>();
    for (const t of page) next.set(this.keyOf(t), t);
    const order = [...next.keys()];
    const predicted = [...this.by.keys()].filter((k) => next.has(k)).concat(order.filter((k) => !this.by.has(k)));
    let i = 0;
    while (i < order.length && predicted[i] === order[i]) i++;
    const moved = new Set(order.slice(i).filter((k) => this.by.has(k)));
    const drop = [...this.by.keys()].filter((k) => !next.has(k) || moved.has(k));
    const set: T[] = [];
    for (const [k, t] of next) if (this.by.get(k) !== t || moved.has(k)) set.push(t);
    this.by = next;
    return { drop, set };
  }
}

export class ModelSender {
  private nodes = new Held<ModelNode>((n) => n.id);
  private picks = new Held<Trigger>((t) => t.id);
  private triggers = new Held<Trigger>((t) => t.id);
  private heard: Onset[] = [];

  delta(now: number, nodes: Map<string, ModelNode>, picks: Map<string, Trigger>, triggers: Trigger[], heard: Onset[]): ModelDelta {
    const n = this.nodes.diff(nodes.values());
    const p = this.picks.diff(picks.values());
    const t = this.triggers.diff(triggers);
    const sent = this.heard;
    const grew = heard.length >= sent.length && (sent.length === 0 || (heard[0] === sent[0] && heard[sent.length - 1] === sent[sent.length - 1]));
    this.heard = [...heard];
    return { now, setNodes: n.set.map(slim), dropNodes: n.drop, addPicks: p.set, dropPicks: p.drop, addTriggers: t.set, dropTriggers: t.drop, heard: grew ? { add: heard.slice(sent.length) } : { all: [...heard] } };
  }
}

export class ModelMirror {
  private nodes = new Map<string, ModelNode>();
  private picks = new Map<string, Trigger>();
  private triggers = new Map<string, Trigger>();
  private heard: Onset[] = [];

  apply(d: ModelDelta): ModelInput {
    d.dropNodes.forEach((id) => this.nodes.delete(id));
    d.setNodes.forEach((n) => this.nodes.set(n.id, n));
    d.dropPicks.forEach((id) => this.picks.delete(id));
    d.addPicks.forEach((t) => this.picks.set(t.id, t));
    d.dropTriggers.forEach((id) => this.triggers.delete(id));
    d.addTriggers.forEach((t) => this.triggers.set(t.id, t));
    this.heard = 'all' in d.heard ? d.heard.all : [...this.heard, ...d.heard.add];
    return { now: d.now, nodes: [...this.nodes.values()], picks: [...this.picks.values()], triggers: [...this.triggers.values()], heard: this.heard };
  }
}
