import type { Event } from 'nostr-tools/pure';
import type { DetectedEvent, Trigger } from '../core/associate';
import { MIN_PICKS, explainedBy, nearby, type EarlyEvent, type Onset } from '../core/early';
import { FELT_EVERY_MS, clusterFelt, type Felt, type FeltCluster } from '../core/felt';
import type { LatLon } from '../core/geo';
import type { RejectReason } from '../core/sensor';
import { filters, parse, signFelt, type Heartbeat, type Message } from '../net/protocol';
import type { Transport } from '../net/transport';
import type { Verify } from '../net/verifier';
import { fetchUsgs, type UsgsQuake, type UsgsWindow } from '../net/usgs';
import type { MapNode } from '../ui/map';
import { Emitter } from './emitter';
import { ModelSender, NODE_STALE_MS, computeModel, isOnline, type Compute, type ModelInput, type ModelOutput } from './model';

export { NODE_STALE_MS };

export interface LiveNode extends Heartbeat {
  id: string;
  /** When this browser first heard it listening without a break: stands in for a missing `since`. */
  firstSeen: number;
  lastSeen: number;
  lastTrigger: number | null;
}

/** Picks, triggers and quakes older than this are forgotten. */
export const WINDOW_MS = 2 * 3600_000;
const MAX_PER_NODE_HOUR = 30;
/** Keys are free, so the per-phone limit alone does not bound memory: keep the newest. */
const MAX_TRIGGERS = 5000;
const MAX_PICKS = 5000;
const MAX_WITHDRAWALS = 5000;
const MAX_WITHDRAWALS_PER_NODE = MAX_PER_NODE_HOUR;
const MAX_FELT = 2000;
/** Phones kept at most: past it, the one silent longest goes. */
export const MAX_NODES = 10_000;
const PICKING_MS = 60_000;
const SHAKEN_MS = 120_000;
/** A provisional detection that neither its phones nor a confirmed one settle this long after it was declared stays unconfirmed. */
export const SETTLE_MS = 2 * 60_000;
const MAX_PROVISIONAL = 500;
/** Relay events wait this long to be checked in one batch, or go at this many. Past MAX_UNCHECKED waiting, the newest are dropped: the checks cannot keep up. */
const CHECK_EVERY_MS = 20;
const CHECK_BATCH = 64;
const MAX_UNCHECKED = 50_000;

/** Picks or triggers by the phone that sent them, so a phone's recent count looks at its own few and not at everyone's. */
class ByNode {
  private by = new Map<string, Trigger[]>();

  add(t: Trigger) {
    const own = this.by.get(t.node);
    if (own) own.push(t);
    else this.by.set(t.node, [t]);
  }

  remove(t: Trigger) {
    const own = this.by.get(t.node);
    const i = own?.indexOf(t) ?? -1;
    if (!own || i < 0) return;
    own.splice(i, 1);
    if (!own.length) this.by.delete(t.node);
  }

  reset(all: Iterable<Trigger>) {
    this.by.clear();
    for (const t of all) this.add(t);
  }

  /** How many of this phone's arrivals started in the last hour. */
  lastHour(node: string, now: number) {
    return (this.by.get(node) ?? []).filter((x) => now - x.t < 3600_000).length;
  }
}

/** A phone withdrew its pick: why it says, and when. */
export interface Withdrawal {
  reason: RejectReason | null;
  at: number;
}

/** A provisional detection, kept for two hours with how it ended. */
export interface Provisional {
  /** Its solution when last declared. */
  event: EarlyEvent;
  /** When this browser first declared it. */
  declared: number;
  /** Every pick that was ever one of its members. */
  picks: Trigger[];
  /** Open while it may still be confirmed. */
  outcome: 'open' | 'confirmed' | 'withdrawn' | 'unconfirmed';
  /** The confirmed event that explains it. */
  confirmed: DetectedEvent | null;
  withdrew: Withdrawal[];
}

/**
 * The live citizen network as seen from this browser: every heartbeat, pick and trigger on
 * the relays, the quakes our association finds in them, and the official USGS feed beside it.
 * Picks and triggers count only from nodes that have announced themselves with a heartbeat.
 */
export class LiveNetwork extends Emitter {
  nodes = new Map<string, LiveNode>();
  triggers: Trigger[] = [];
  picks = new Map<string, Trigger>();
  /** Confirmed events (from vetted triggers). */
  events: DetectedEvent[] = [];
  /** Provisional events from raw picks that no confirmed event explains yet. */
  early: EarlyEvent[] = [];
  /** Every provisional detection of the last two hours, oldest first, with its outcome. */
  provisional: Provisional[] = [];
  /** Shaking people reported feeling in the last two hours, from anyone, sensor or not. */
  felt: Felt[] = [];
  /** The shakings among them that three keys in three places agree on. */
  feltClusters: FeltCluster[] = [];
  usgs: UsgsQuake[] = [];
  usgsState: 'loading' | 'ok' | 'error' = 'loading';
  usgsWindow: UsgsWindow;
  private pending: Message[] = [];
  private unchecked: Event[] = [];
  /** Events handed over and not yet taken in. */
  private backlog = 0;
  private inOrder: Promise<void> = Promise.resolve();
  private pickedBy = new ByNode();
  private triggeredBy = new ByNode();
  private triggerIds = new Set<string>();
  /**
   * Retractions by `pick:phone`, from phones with a heartbeat. One can arrive before its pick,
   * and only the pick's own author may retract it, so every retracting phone is kept until the
   * pick shows.
   */
  private withdrawals = new Map<string, Withdrawal & { node: string }>();
  /** Each phone's withdrawals, oldest first. */
  private withdrawnBy = new Map<string, string[]>();
  /** Every onset heard, withdrawn or not: which phones felt something, and when. */
  private heard: Onset[] = [];
  private recomputeQueued = false;
  private computing = false;
  private sender = new ModelSender();
  private again = false;
  private waiting = false;
  /** How long the last recompute took, ms: a big network waits longer between them, so the page keeps most of its time. */
  private recomputeCost = 0;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private usgsAsked = 0;
  private usgsShown = 0;

  constructor(
    readonly transport: Transport,
    usgsWindow: UsgsWindow,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    /** Where relay events are checked; without one, here and at once. */
    private readonly verify?: Verify,
    /** Where the quakes are worked out from what has been heard; without one, here and at once. */
    private compute?: Compute,
  ) {
    super();
    this.usgsWindow = usgsWindow;
  }

  start() {
    this.transport.subscribe(() => filters(Date.now() - WINDOW_MS), (ev) => this.take(ev));
    this.transport.onStatus(() => this.emit());
    this.refreshUsgs();
    setInterval(() => this.refreshUsgs(), 120_000);
    setInterval(() => this.prune(), 15_000);
  }

  setUsgsWindow(w: UsgsWindow) {
    this.usgsWindow = w;
    this.usgs = [];
    this.usgsState = 'loading';
    this.emit();
    this.refreshUsgs();
  }

  async refreshUsgs() {
    const w = this.usgsWindow;
    const asked = ++this.usgsAsked;
    let quakes: UsgsQuake[] | null = null;
    try {
      quakes = await fetchUsgs(w, this.fetchImpl);
    } catch {
    }
    if (w !== this.usgsWindow || asked < this.usgsShown) return;
    this.usgsShown = asked;
    if (quakes) this.usgs = quakes;
    this.usgsState = quakes ? 'ok' : 'error';
    this.emit();
  }

  ingest(ev: Event) {
    const m = parse(ev);
    if (m) this.receive(m);
  }

  /** An event from a relay: checked beside the page when there is a verifier, in the order they came. */
  private take(ev: Event) {
    const verify = this.verify;
    if (!verify) return this.ingest(ev);
    if (this.backlog >= MAX_UNCHECKED) return;
    this.backlog++;
    this.unchecked.push(ev);
    if (this.unchecked.length >= CHECK_BATCH) this.sendUnchecked(verify);
    else if (this.unchecked.length === 1) setTimeout(() => this.sendUnchecked(verify), CHECK_EVERY_MS);
  }

  private sendUnchecked(verify: Verify) {
    const batch = this.unchecked.splice(0);
    if (!batch.length) return;
    const checked = verify(batch, Date.now()).catch(() => []);
    this.inOrder = this.inOrder.then(() => checked).then((messages) => {
      this.backlog -= batch.length;
      messages.forEach((m) => m && this.receive(m));
    });
  }

  /** One message whose signature and shape `parse` has checked. */
  receive(m: Message) {
    if (m.type === 'heartbeat') {
      const prev = this.nodes.get(m.node);
      if (prev && prev.lastSeen > m.at) return;
      // shortcut: a linear scan for the quietest phone once full; keep phones ordered by lastSeen if floods of new keys make it slow.
      if (!prev && this.nodes.size >= MAX_NODES) this.nodes.delete([...this.nodes.values()].reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a)).id);
      const resumed = !prev || prev.sps === 0 || m.at - prev.lastSeen > NODE_STALE_MS;
      this.nodes.set(m.node, { ...m.data, id: m.node, firstSeen: resumed ? m.at : prev.firstSeen, lastSeen: m.at, lastTrigger: prev?.lastTrigger ?? null });
      if (this.pending.length) {
        const held = this.pending.filter((p) => p.node === m.node);
        this.pending = this.pending.filter((p) => p.node !== m.node);
        held.forEach((p) => this.receive(p));
      }
      this.queueRecompute();
    } else if (m.type !== 'felt' && !this.nodes.has(m.node)) {
      this.pending = [...this.pending, m].slice(-500);
      return;
    } else if (m.type === 'retract') {
      // NIP-09: only the author may retract their own pick.
      const p = this.picks.get(m.pick);
      if (p && p.node !== m.node) return;
      const key = `${m.pick}:${m.node}`;
      if (!this.withdrawals.has(key)) {
        const own = this.withdrawnBy.get(m.node) ?? [];
        if (own.length >= MAX_WITHDRAWALS_PER_NODE) this.forget(own[0]);
        if (this.withdrawals.size >= MAX_WITHDRAWALS) this.forget(this.withdrawals.keys().next().value!);
        this.withdrawnBy.set(m.node, [...(this.withdrawnBy.get(m.node) ?? []), key]);
      }
      this.withdrawals.set(key, { reason: m.reason, at: m.at, node: m.node });
      this.dropPick(m.pick);
      this.queueRecompute();
    } else if (m.type === 'felt') {
      if (m.data.t < Date.now() - WINDOW_MS || this.felt.some((f) => f.id === m.id)) return;
      this.felt.push({ id: m.id, node: m.node, ...m.data });
      if (this.felt.length > MAX_FELT) this.felt.shift();
      this.queueRecompute();
    } else {
      if (m.data.t < Date.now() - WINDOW_MS) return;
      const t: Trigger = { id: m.id, node: m.node, lat: m.data.lat, lon: m.data.lon, t: m.data.t, pga: m.type === 'trigger' ? m.data.pga : 0, phase: m.data.phase };
      if (m.type === 'trigger' && m.pick) t.pick = m.pick;
      const n = this.nodes.get(m.node)!;
      if (m.type === 'pick') {
        if (this.picks.has(t.id) || this.pickedBy.lastHour(m.node, Date.now()) >= MAX_PER_NODE_HOUR) return;
        this.hear(t);
        // A retraction can arrive before its pick.
        if (this.withdrawals.has(`${t.id}:${t.node}`)) return;
        this.picks.set(t.id, t);
        this.pickedBy.add(t);
        if (this.picks.size > MAX_PICKS) this.dropPick(this.picks.keys().next().value!);
      } else {
        if (this.triggerIds.has(t.id) || this.triggeredBy.lastHour(m.node, Date.now()) >= MAX_PER_NODE_HOUR) return;
        this.hear(t);
        this.triggers.push(t);
        this.triggerIds.add(t.id);
        this.triggeredBy.add(t);
        if (this.triggers.length > MAX_TRIGGERS) this.dropTrigger(this.triggers.shift()!);
        n.lastTrigger = Math.max(n.lastTrigger ?? 0, t.t);
      }
      this.queueRecompute();
    }
    this.emit();
  }

  /** This key's felt report within ten minutes of t, if any. */
  lastFelt(node: string, t: number) {
    return this.felt.find((f) => f.node === node && Math.abs(f.t - t) < FELT_EVERY_MS);
  }

  /** Publish this browser's felt report of shaking at `t`, unless its key reported shaking within ten minutes of then. */
  reportFelt(me: { sk: Uint8Array; pubkey: string }, at: LatLon, lvl: number, t = Date.now()) {
    if (this.lastFelt(me.pubkey, t)) return false;
    const ev = signFelt(me.sk, { ...at, t, lvl });
    this.transport.publish(ev);
    this.ingest(ev);
    return true;
  }

  private hear(t: Trigger) {
    this.heard.push({ node: t.node, t: t.t });
    if (this.heard.length > MAX_TRIGGERS + MAX_PICKS) this.heard.shift();
  }

  private forget(withdrawal: string) {
    const { node } = this.withdrawals.get(withdrawal)!;
    this.withdrawals.delete(withdrawal);
    const rest = this.withdrawnBy.get(node)!.filter((k) => k !== withdrawal);
    if (rest.length) this.withdrawnBy.set(node, rest);
    else this.withdrawnBy.delete(node);
  }

  private dropPick(id: string) {
    const t = this.picks.get(id);
    if (!t) return;
    this.picks.delete(id);
    this.pickedBy.remove(t);
  }

  private dropTrigger(t: Trigger) {
    this.triggerIds.delete(t.id);
    this.triggeredBy.remove(t);
  }

  private queueRecompute() {
    if (this.recomputeQueued) return;
    this.recomputeQueued = true;
    setTimeout(() => {
      this.recomputeQueued = false;
      this.recompute();
      if (!this.compute) this.emit();
    }, this.pause(200));
  }

  /** At least `ms`, and at least three times what a recompute costs now: a quarter of the page's time at most. */
  private pause(ms: number) {
    return Math.min(2000, Math.max(ms, 3 * this.recomputeCost));
  }

  /** What the model works from, here. */
  private snapshot(now: number): ModelInput {
    return { now, nodes: [...this.nodes.values()], picks: [...this.picks.values()], triggers: this.triggers, heard: this.heard };
  }

  recompute(now = Date.now()) {
    clearTimeout(this.recheck);
    if (!this.compute) {
      const began = Date.now();
      this.apply(computeModel(this.snapshot(now)), now);
      this.recomputeCost = Date.now() - began;
      this.scheduleRecheck();
      return;
    }
    // One at a time: what arrives while it works is taken up when it is done.
    if (this.computing) return void (this.again = true);
    this.computing = true;
    const began = Date.now();
    const delta = this.sender.delta(now, this.nodes, this.picks, this.triggers, this.heard);
    this.recomputeCost = Date.now() - began;
    this.compute(delta).then(
      (out) => {
        this.computing = false;
        const applied = Date.now();
        this.apply(out, now);
        // The page's own share is small; the worker's is not, and it too is spared the next few moments.
        this.recomputeCost = Math.max(Date.now() - applied, (applied - began) / 3);
        this.scheduleRecheck();
        this.emit();
        if (this.again) {
          this.again = false;
          this.queueRecompute();
        }
      },
      () => {
        // The worker failed, and what it was told is gone with it: from here the page does the work.
        this.computing = false;
        this.compute = undefined;
        this.queueRecompute();
      },
    );
  }

  private apply(out: ModelOutput, now: number) {
    this.events = out.events;
    this.early = out.early;
    this.waiting = out.waiting;
    this.settle(now);
    this.feltClusters = clusterFelt(this.felt);
  }

  private scheduleRecheck() {
    // A candidate holds for now, but phones the wave is still reaching could overturn it.
    if (this.waiting)
      this.recheck = setTimeout(() => {
        this.recompute();
        if (!this.compute) this.emit();
      }, this.pause(500));
  }

  private settle(now: number) {
    for (const e of this.early) {
      const ids = new Set(e.triggers.map((t) => t.id));
      const open = this.provisional.filter((x) => x.outcome === 'open');
      const d = open.find((x) => x.picks.some((p) => ids.has(p.id))) ?? open.find((x) => nearby(e, x.event));
      if (!d) this.provisional.push({ event: e, declared: now, picks: [...e.triggers], outcome: 'open', confirmed: null, withdrew: [] });
      else {
        d.event = e;
        const had = new Set(d.picks.map((p) => p.id));
        d.picks.push(...e.triggers.filter((t) => !had.has(t.id)));
      }
    }
    for (const d of this.provisional) {
      d.confirmed = explainedBy(d.event, d.picks, this.events) ?? (d.outcome === 'confirmed' ? d.confirmed : null);
      if (d.outcome === 'confirmed') continue;
      if (d.outcome === 'open') d.withdrew = d.picks.flatMap((p) => this.withdrawals.get(`${p.id}:${p.node}`) ?? []);
      if (d.confirmed) d.outcome = 'confirmed';
      else if (d.outcome === 'open' && !this.early.includes(d.event)) {
        if (d.picks.length - d.withdrew.length < MIN_PICKS) d.outcome = 'withdrawn';
        else if (now - d.declared >= SETTLE_MS) d.outcome = 'unconfirmed';
      }
    }
    this.provisional = this.provisional.filter((d) => now - d.declared < WINDOW_MS).slice(-MAX_PROVISIONAL);
  }

  private prune() {
    const now = Date.now();
    const kept = this.triggers.filter((t) => now - t.t < WINDOW_MS);
    if (kept.length < this.triggers.length) {
      this.triggers = kept;
      this.triggerIds = new Set(kept.map((t) => t.id));
      this.triggeredBy.reset(kept);
    }
    this.heard = this.heard.filter((h) => now - h.t < WINDOW_MS);
    this.felt = this.felt.filter((f) => now - f.t < WINDOW_MS);
    for (const [k, p] of this.picks) if (now - p.t > 5 * 60_000) this.dropPick(k);
    for (const [k, n] of this.nodes) if (now - n.lastSeen > WINDOW_MS) this.nodes.delete(k);
    for (const [k, w] of this.withdrawals) if (now - w.at > WINDOW_MS) this.forget(k);
    this.queueRecompute();
  }

  /** 0..1: how busy the last few seconds were, from the picks and triggers heard. */
  activity(now = Date.now()) {
    const recent = (t: number) => now - t < 8000;
    return Math.min(1, ([...this.picks.values()].filter((p) => recent(p.t)).length + this.triggers.filter((t) => recent(t.t)).length) / 6);
  }

  /** Every phone as the map draws it now: offline, confirmed shaking, checking a pick, or idle. */
  nodeStates(now = Date.now()): MapNode[] {
    const picking = new Set([...this.picks.values()].filter((p) => now - p.t < PICKING_MS).map((p) => p.node));
    return [...this.nodes.values()].map((n) => ({
      id: n.id,
      lat: n.lat,
      lon: n.lon,
      state: !this.isOnline(n, now) ? 'offline' : n.lastTrigger !== null && now - n.lastTrigger < SHAKEN_MS ? 'trigger' : picking.has(n.id) ? 'pick' : 'idle',
    }));
  }

  /** Whether a phone was listening at time t (see `isOnline`). */
  isOnline(n: LiveNode, t = Date.now()) {
    return isOnline(n, t);
  }
}
