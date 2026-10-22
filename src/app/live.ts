import type { Event } from 'nostr-tools/pure';
import type { DetectedEvent, Trigger } from '../core/associate';
import { confirmedEvents, earlyDetect, unconfirmed, type EarlyEvent, type Onset } from '../core/early';
import { HEARTBEAT_EVERY_MS, filters, parse, type Heartbeat } from '../net/protocol';
import type { Transport } from '../net/transport';
import { fetchUsgs, type UsgsQuake, type UsgsWindow } from '../net/usgs';
import { Emitter } from './emitter';

export interface LiveNode extends Heartbeat {
  id: string;
  lastSeen: number;
  lastTrigger: number | null;
}

const WINDOW_MS = 2 * 3600_000;
/** A phone that has missed three heartbeats is offline. */
const NODE_STALE_MS = 3 * HEARTBEAT_EVERY_MS;
const MAX_PER_NODE_HOUR = 30;
/** Keys are free, so the per-phone limit alone does not bound memory: keep the newest. */
const MAX_TRIGGERS = 5000;
const MAX_PICKS = 5000;

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
  usgs: UsgsQuake[] = [];
  usgsState: 'loading' | 'ok' | 'error' = 'loading';
  usgsWindow: UsgsWindow;
  private pending: { node: string; ev: Event }[] = [];
  /** Retracted pick → the phone that retracted it. Only a pick's own author may. */
  private retracted = new Map<string, string>();
  /** Every onset heard, withdrawn or not: which phones felt something, and when. */
  private heard: Onset[] = [];
  private recomputeQueued = false;
  private recheck: ReturnType<typeof setTimeout> | undefined;

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
    this.usgsState = 'loading';
    this.emit();
    this.refreshUsgs();
  }

  async refreshUsgs() {
    try {
      this.usgs = await fetchUsgs(this.usgsWindow, this.fetchImpl);
      this.usgsState = 'ok';
    } catch {
      this.usgsState = 'error';
    }
    this.emit();
  }

  ingest(ev: Event) {
    const m = parse(ev);
    if (!m) return;
    if (m.type === 'heartbeat') {
      const prev = this.nodes.get(m.node);
      if (prev && prev.lastSeen > m.at) return;
      this.nodes.set(m.node, { ...m.data, id: m.node, lastSeen: m.at, lastTrigger: prev?.lastTrigger ?? null });
      const held = this.pending.filter((p) => p.node === m.node);
      this.pending = this.pending.filter((p) => p.node !== m.node);
      held.forEach((p) => this.ingest(p.ev));
    } else if (m.type === 'retract') {
      // NIP-09: only the author may retract their own pick.
      const p = this.picks.get(m.pick);
      if (p && p.node !== m.node) return;
      this.retracted.set(m.pick, m.node);
      this.picks.delete(m.pick);
      this.queueRecompute();
    } else {
      if (!this.nodes.has(m.node)) {
        this.pending = [...this.pending, { node: m.node, ev }].slice(-500);
        return;
      }
      if (m.data.t < Date.now() - WINDOW_MS) return;
      const t: Trigger = { id: m.id, node: m.node, lat: m.data.lat, lon: m.data.lon, t: m.data.t, pga: m.type === 'trigger' ? m.data.pga : 0, phase: m.data.phase };
      const n = this.nodes.get(m.node)!;
      if (m.type === 'pick') {
        if (this.picks.has(t.id) || this.burst(m.node, [...this.picks.values()])) return;
        this.hear(t);
        // A retraction can arrive before its pick.
        if (this.retracted.get(t.id) === t.node) return;
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
    // A candidate holds for now, but phones the wave is still reaching could overturn it.
    if (early.waiting)
      this.recheck = setTimeout(() => {
        this.recompute();
        this.emit();
      }, 500);
  }

  private prune() {
    const now = Date.now();
    this.triggers = this.triggers.filter((t) => now - t.t < WINDOW_MS);
    this.heard = this.heard.filter((h) => now - h.t < WINDOW_MS);
    for (const [k, p] of this.picks) if (now - p.t > 5 * 60_000) this.picks.delete(k);
    for (const [k, n] of this.nodes) if (now - n.lastSeen > WINDOW_MS) this.nodes.delete(k);
    if (this.retracted.size > 5000) this.retracted.clear();
    this.queueRecompute();
  }

  /** 0..1: how busy the last few seconds were, from the picks and triggers heard. */
  activity(now = Date.now()) {
    const recent = (t: number) => now - t < 8000;
    return Math.min(1, ([...this.picks.values()].filter((p) => recent(p.t)).length + this.triggers.filter((t) => recent(t.t)).length) / 6);
  }

  /**
   * Whether a phone was listening at time t: it had started by then, and was heard from after
   * it, or shortly before without saying it had stopped.
   */
  isOnline(n: LiveNode, t = Date.now()) {
    if ((n.since ?? n.lastSeen) > t) return false;
    return n.lastSeen >= t || (n.sps > 0 && t - n.lastSeen < NODE_STALE_MS);
  }
}
