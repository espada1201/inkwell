import type { DetectedEvent, Trigger } from '../core/associate';
import { confirmedEvents, earlyDetect, unconfirmed, type EarlyEvent, type Onset } from '../core/early';
import { HEARTBEAT_EVERY_MS } from '../net/protocol';

/** A phone that has missed three heartbeats is offline. */
export const NODE_STALE_MS = 3 * HEARTBEAT_EVERY_MS;

/** What the model needs to know about a phone to say whether it was listening. */
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

/** Everything the association, the location and the quiet phones' veto work from. */
export interface ModelInput {
  now: number;
  nodes: ModelNode[];
  picks: Trigger[];
  triggers: Trigger[];
  heard: Onset[];
}

export interface ModelOutput {
  /** Confirmed events (from vetted triggers). */
  events: DetectedEvent[];
  /** Provisional events from raw picks that no confirmed event explains yet. */
  early: EarlyEvent[];
  /** A candidate holds for now, but phones the wave is still reaching could overturn it. */
  waiting: boolean;
}

/** Runs the heavy part of a recompute: a function of its input alone, so it can run beside the page. */
export function computeModel({ now, nodes, picks, triggers, heard }: ModelInput): ModelOutput {
  // Confirmed events face the phones that were listening when they struck, and stayed quiet.
  const events = confirmedEvents(triggers, heard, (t) => nodes.filter((n) => isOnline(n, t)), now);
  const early = earlyDetect(picks, nodes.filter((n) => isOnline(n, now)), now);
  return { events, early: unconfirmed(early.events, events), waiting: early.waiting };
}

/**
 * What changed since the last one sent. A network of thousands of phones changes a little each
 * moment, so a worker is told only that, and keeps the rest.
 */
export interface ModelDelta {
  now: number;
  setNodes: ModelNode[];
  dropNodes: string[];
  addPicks: Trigger[];
  dropPicks: string[];
  addTriggers: Trigger[];
  dropTriggers: string[];
  /** The onsets heard: all of them again, or only the ones after those already sent. */
  heard: { all: Onset[] } | { add: Onset[] };
}

/** Works out a model from the changes since the last, here or in a worker. A failure ends the stream: the page then works it out itself. */
export type Compute = (delta: ModelDelta) => Promise<ModelOutput>;

const slim = ({ id, lat, lon, sps, since, firstSeen, lastSeen }: ModelNode): ModelNode => ({ id, lat, lon, sps, since, firstSeen, lastSeen });

/** The page's side: remembers what the worker has been told, and says what has changed since. */
export class ModelSender {
  private nodes = new Map<string, ModelNode>();
  private picks = new Set<string>();
  private triggers = new Set<string>();
  private heard: Onset[] = [];

  delta(now: number, nodes: Map<string, ModelNode>, picks: Map<string, Trigger>, triggers: Trigger[], heard: Onset[]): ModelDelta {
    const setNodes: ModelNode[] = [];
    for (const [id, n] of nodes)
      if (this.nodes.get(id) !== n) {
        this.nodes.set(id, n);
        setNodes.push(slim(n));
      }
    const dropNodes = [...this.nodes.keys()].filter((id) => !nodes.has(id));
    dropNodes.forEach((id) => this.nodes.delete(id));

    const addPicks = [...picks.values()].filter((t) => !this.picks.has(t.id));
    const dropPicks = [...this.picks].filter((id) => !picks.has(id));
    addPicks.forEach((t) => this.picks.add(t.id));
    dropPicks.forEach((id) => this.picks.delete(id));

    const now_ = new Set(triggers.map((t) => t.id));
    const addTriggers = triggers.filter((t) => !this.triggers.has(t.id));
    const dropTriggers = [...this.triggers].filter((id) => !now_.has(id));
    addTriggers.forEach((t) => this.triggers.add(t.id));
    dropTriggers.forEach((id) => this.triggers.delete(id));

    // Onsets only ever join at the end, until a few expire from the front or the middle.
    const sent = this.heard;
    const grew = heard.length >= sent.length && (sent.length === 0 || (heard[0] === sent[0] && heard[sent.length - 1] === sent[sent.length - 1]));
    this.heard = [...heard];
    return { now, setNodes, dropNodes, addPicks, dropPicks, addTriggers, dropTriggers, heard: grew ? { add: heard.slice(sent.length) } : { all: [...heard] } };
  }
}

/** The worker's side: the network as last told, rebuilt from the changes. */
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
