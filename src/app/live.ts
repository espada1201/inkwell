import type { Event } from 'nostr-tools/pure';
import type { DetectedEvent, Trigger } from '../core/associate';
import { MIN_PICKS, confirmedEvents, earlyDetect, explainedBy, nearby, unconfirmed, type EarlyEvent, type Onset } from '../core/early';
import { FELT_EVERY_MS, clusterFelt, type Felt, type FeltCluster } from '../core/felt';
import type { LatLon } from '../core/geo';
import type { RejectReason } from '../core/sensor';
import { HEARTBEAT_EVERY_MS, filters, parse, signFelt, type Heartbeat, type Message } from '../net/protocol';
import type { Transport } from '../net/transport';
import { fetchUsgs, type UsgsQuake, type UsgsWindow } from '../net/usgs';
import type { MapNode } from '../ui/map';
import { Emitter } from './emitter';

export interface LiveNode extends Heartbeat {
  id: string;
  /** When this browser first heard it listening without a break: stands in for a missing `since`. */
  firstSeen: number;
  lastSeen: number;
  lastTrigger: number | null;
}

/** Picks, triggers and quakes older than this are forgotten. */
export const WINDOW_MS = 2 * 3600_000;
/** A phone that has missed three heartbeats is offline. */
export const NODE_STALE_MS = 3 * HEARTBEAT_EVERY_MS;
const MAX_PER_NODE_HOUR = 30;
/** Keys are free, so the per-phone limit alone does not bound memory: keep the newest. */
const MAX_TRIGGERS = 5000;
const MAX_PICKS = 5000;
const MAX_WITHDRAWALS = 5000;
const MAX_FELT = 2000;
/** Phones kept at most: past it, the one silent longest goes. */
export const MAX_NODES = 10_000;
const PICKING_MS = 60_000;
const SHAKEN_MS = 120_000;
/** A provisional detection that neither its phones nor a confirmed one settle this long after it was declared stays unconfirmed. */
export const SETTLE_MS = 2 * 60_000;
const MAX_PROVISIONAL = 500;

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
  /**
   * Retractions by `pick:phone`, from phones with a heartbeat. One can arrive before its pick,
   * and only the pick's own author may retract it, so every retracting phone is kept until the
   * pick shows.
   */
  private withdrawals = new Map<string, Withdrawal>();
  /** Every onset heard, withdrawn or not: which phones felt something, and when. */
  private heard: Onset[] = [];
  private recomputeQueued = false;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private usgsAsked = 0;
  private usgsShown = 0;

  constructor(
    readonly transport: Transport,
    usgsWindow: UsgsWindow,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    super();
    this.usgsWindow = usgsWindow;
  }

  start() {
    this.transport.subscribe(() => filters(Date.now() - WINDOW_MS), (ev) => this.ingest(ev));
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

  /** One message whose signature and shape `parse` has checked. */
  receive(m: Message) {
    if (m.type === 'heartbeat') {
      const prev = this.nodes.get(m.node);
      if (prev && prev.lastSeen > m.at) return;
      if (!prev && this.nodes.size >= MAX_NODES) this.nodes.delete([...this.nodes.values()].reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a)).id);
      const resumed = !prev || prev.sps === 0 || m.at - prev.lastSeen > NODE_STALE_MS;
      this.nodes.set(m.node, { ...m.data, id: m.node, firstSeen: resumed ? m.at : prev.firstSeen, lastSeen: m.at, lastTrigger: prev?.lastTrigger ?? null });
      const held = this.pending.filter((p) => p.node === m.node);
      this.pending = this.pending.filter((p) => p.node !== m.node);
      held.forEach((p) => this.receive(p));
      this.queueRecompute();
    } else if (m.type !== 'felt' && !this.nodes.has(m.node)) {
      this.pending = [...this.pending, m].slice(-500);
      return;
    } else if (m.type === 'retract') {
      // NIP-09: only the author may retract their own pick.
      const p = this.picks.get(m.pick);
      if (p && p.node !== m.node) return;
      this.withdrawals.set(`${m.pick}:${m.node}`, { reason: m.reason, at: m.at });
      if (this.withdrawals.size > MAX_WITHDRAWALS) this.withdrawals.delete(this.withdrawals.keys().next().value!);
      this.picks.delete(m.pick);
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
        if (this.picks.has(t.id) || this.burst(m.node, [...this.picks.values()])) return;
        this.hear(t);
        // A retraction can arrive before its pick.
        if (this.withdrawals.has(`${t.id}:${t.node}`)) return;
        this.picks.set(t.id, t);
        if (this.picks.size > MAX_PICKS) this.picks.delete(this.picks.keys().next().value!);
      } else {
        if (this.triggers.some((x) => x.id === t.id) || this.burst(m.node, this.triggers)) return;
        this.hear(t);
        this.triggers.push(t);
        if (this.triggers.length > MAX_TRIGGERS) this.triggers.shift();
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

  /** Publish this browser's felt report, unless its key sent one in the last ten minutes. */
  reportFelt(me: { sk: Uint8Array; pubkey: string }, at: LatLon, lvl: number) {
    const t = Date.now();
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

  /** Simple per-node rate limit so one broken or hostile phone cannot flood the detector. */
  private burst(node: string, list: Trigger[]) {
    const now = Date.now();
    return list.filter((x) => x.node === node && now - x.t < 3600_000).length >= MAX_PER_NODE_HOUR;
  }

  private queueRecompute() {
    if (this.recomputeQueued) return;
    this.recomputeQueued = true;
    setTimeout(() => {
      this.recomputeQueued = false;
      this.recompute();
      this.emit();
    }, 200);
  }

  recompute(now = Date.now()) {
    clearTimeout(this.recheck);
    const nodes = [...this.nodes.values()];
    // Confirmed events face the phones that were listening when they struck, and stayed quiet.
    this.events = confirmedEvents(this.triggers, this.heard, (t) => nodes.filter((n) => this.isOnline(n, t)), now);
    const early = earlyDetect(
      [...this.picks.values()],
      nodes.filter((n) => this.isOnline(n, now)),
      now,
    );
    this.early = unconfirmed(early.events, this.events);
    this.settle(now);
    this.feltClusters = clusterFelt(this.felt);
    // A candidate holds for now, but phones the wave is still reaching could overturn it.
    if (early.waiting)
      this.recheck = setTimeout(() => {
        this.recompute();
        this.emit();
      }, 500);
  }

  private settle(now: number) {
    for (const e of this.early) {
      const ids = new Set(e.triggers.map((t) => t.id));
      const open = this.provisional.filter((x) => x.outcome === 'open');
      const d = open.find((x) => x.picks.some((p) => ids.has(p.id))) ?? open.find((x) => nearby(e, x.event));
      if (!d) this.provisional.push({ event: e, declared: now, picks: [...e.triggers], outcome: 'open', confirmed: null, withdrew: [] });
      else {
        d.event = e;
        d.picks.push(...e.triggers.filter((t) => !d.picks.some((p) => p.id === t.id)));
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
    this.triggers = this.triggers.filter((t) => now - t.t < WINDOW_MS);
    this.heard = this.heard.filter((h) => now - h.t < WINDOW_MS);
    this.felt = this.felt.filter((f) => now - f.t < WINDOW_MS);
    for (const [k, p] of this.picks) if (now - p.t > 5 * 60_000) this.picks.delete(k);
    for (const [k, n] of this.nodes) if (now - n.lastSeen > WINDOW_MS) this.nodes.delete(k);
    for (const [k, w] of this.withdrawals) if (now - w.at > WINDOW_MS) this.withdrawals.delete(k);
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

  /**
   * Whether a phone was listening at time t: it had started by then, and was heard from after
   * it, or shortly before without saying it had stopped.
   */
  isOnline(n: LiveNode, t = Date.now()) {
    if ((n.since ?? n.firstSeen) > t) return false;
    return n.lastSeen >= t || (n.sps > 0 && t - n.lastSeen < NODE_STALE_MS);
  }
}
