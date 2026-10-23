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

export type Compute = (delta: ModelDelta) => Promise<ModelOutput>;

const slim = ({ id, lat, lon, sps, since, firstSeen, lastSeen }: ModelNode): ModelNode => ({ id, lat, lon, sps, since, firstSeen, lastSeen });

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

    const current = new Set(triggers.map((t) => t.id));
    const addTriggers = triggers.filter((t) => !this.triggers.has(t.id));
    const dropTriggers = [...this.triggers].filter((id) => !current.has(id));
    addTriggers.forEach((t) => this.triggers.add(t.id));
    dropTriggers.forEach((id) => this.triggers.delete(id));

    const sent = this.heard;
    const grew = heard.length >= sent.length && (sent.length === 0 || (heard[0] === sent[0] && heard[sent.length - 1] === sent[sent.length - 1]));
    this.heard = [...heard];
    return { now, setNodes, dropNodes, addPicks, dropPicks, addTriggers, dropTriggers, heard: grew ? { add: heard.slice(sent.length) } : { all: [...heard] } };
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
