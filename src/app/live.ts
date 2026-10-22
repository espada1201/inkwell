import type { Event } from 'nostr-tools/pure';
import { associate, type DetectedEvent, type Trigger } from '../core/associate';
import { earlyDetect, type EarlyEvent } from '../core/early';
import { distanceKm } from '../core/geo';
import { filters, parse, type Heartbeat } from '../net/protocol';
import type { Transport } from '../net/transport';
import { fetchUsgs, type UsgsQuake, type UsgsWindow } from '../net/usgs';
import { Emitter } from '../ui/dom';

export interface LiveNode extends Heartbeat {
  id: string;
  lastSeen: number;
  lastTrigger: number | null;
  lastPick: number | null;
}

const WINDOW_MS = 2 * 3600_000;
const NODE_STALE_MS = 10 * 60_000;
const MAX_PER_NODE_HOUR = 30;

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
  private retracted = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsub: (() => void) | null = null;
  private recomputeQueued = false;

  constructor(
    readonly transport: Transport,
    usgsWindow: UsgsWindow,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    super();
    this.usgsWindow = usgsWindow;
  }

  start() {
    this.unsub = this.transport.subscribe(filters(Date.now() - WINDOW_MS), (ev) => this.ingest(ev));
    this.transport.onStatus(() => this.emit());
    this.refreshUsgs();
    this.timers.push(setInterval(() => this.refreshUsgs(), 120_000));
    this.timers.push(setInterval(() => this.prune(), 15_000));
  }

  stop() {
    this.unsub?.();
    this.timers.forEach(clearInterval);
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
      this.nodes.set(m.node, { ...m.data, id: m.node, lastSeen: m.at, lastTrigger: prev?.lastTrigger ?? null, lastPick: prev?.lastPick ?? null });
      const held = this.pending.filter((p) => p.node === m.node);
      this.pending = this.pending.filter((p) => p.node !== m.node);
      held.forEach((p) => this.ingest(p.ev));
    } else if (m.type === 'retract') {
      // NIP-09: only the author may retract their own pick.
      const p = this.picks.get(m.pick);
      if (p && p.node !== m.node) return;
      this.retracted.add(m.pick);
      this.picks.delete(m.pick);
      this.queueRecompute();
    } else {
      if (!this.nodes.has(m.node)) {
        this.pending = [...this.pending, { node: m.node, ev }].slice(-500);
        return;
      }
      const t: Trigger = { id: m.id, node: m.node, lat: m.data.lat, lon: m.data.lon, t: m.data.t, pga: m.type === 'trigger' ? m.data.pga : 0, phase: m.data.phase };
      const n = this.nodes.get(m.node)!;
      if (m.type === 'pick') {
        if (this.picks.has(t.id) || this.retracted.has(t.id) || this.burst(m.node, [...this.picks.values()])) return;
        this.picks.set(t.id, t);
        n.lastPick = Math.max(n.lastPick ?? 0, t.t);
      } else {
        if (this.triggers.some((x) => x.id === t.id) || this.burst(m.node, this.triggers)) return;
        this.triggers.push(t);
        n.lastTrigger = Math.max(n.lastTrigger ?? 0, t.t);
      }
      this.queueRecompute();
    }
    this.emit();
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
    this.events = associate(this.triggers);
    const online = [...this.nodes.values()].filter((n) => this.isOnline(n, now));
    this.early = earlyDetect([...this.picks.values()], online, now).filter(
      (e) => !this.events.some((c) => distanceKm(c, e) < 80 && Math.abs(c.time - e.time) < 60_000),
    );
  }

  private prune() {
    const now = Date.now();
    this.triggers = this.triggers.filter((t) => now - t.t < WINDOW_MS);
    for (const [k, p] of this.picks) if (now - p.t > 5 * 60_000) this.picks.delete(k);
    for (const [k, n] of this.nodes) if (now - n.lastSeen > WINDOW_MS) this.nodes.delete(k);
    if (this.retracted.size > 5000) this.retracted.clear();
    this.queueRecompute();
  }

  isOnline(n: LiveNode, now = Date.now()) {
    return now - n.lastSeen < NODE_STALE_MS;
  }
}
