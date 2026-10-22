import { associate, type DetectedEvent, type Trigger } from '../core/associate';
import { earlyDetect, type EarlyEvent } from '../core/early';
import { Bandpass } from '../core/filters';
import { warningSummary, type WarningSummary } from '../core/impact';
import { VP_KMS, VS_KMS } from '../core/physics';
import { ORIGIN_OFFSET_S, simulate, type Scenario, type Simulation } from '../core/scenarios';
import type { Phase } from '../core/physics';
import type { RejectReason } from '../core/sensor';
import { Emitter } from '../ui/dom';

export interface ReplayNodeView {
  id: string;
  lat: number;
  lon: number;
  distKm: number | null;
  /** Bandpassed shaking magnitude per sample, m/s². */
  trace: Float32Array;
  /** Scenario-relative ms (onset t, sent at), and the wave the phone felt. */
  picks: { t: number; at: number; phase: Phase }[];
  trigger: { t: number; at: number; pga: number } | null;
  rejects: { t: number; at: number; reason: RejectReason }[];
}

/** What a browser watching the relays receives, in order. */
interface Arrival {
  at: number;
  kind: 'pick' | 'retract' | 'trigger';
  tr: Trigger;
}

const FS = 50;
/** Assumed phone → relay → browser latency, ms. */
export const RELAY_LATENCY_MS = 1000;

/**
 * Plays a bundled scenario on a virtual clock. Every phone's synthetic record has already
 * been run through the real on-device detector. Picks, retractions and triggers then
 * "arrive" with relay latency, and the same early-detection and association code the live
 * network uses runs on exactly what has arrived so far.
 */
export class Replay extends Emitter {
  sim: Simulation | null = null;
  nodes: ReplayNodeView[] = [];
  /** Virtual ms since scenario start. */
  vt = 0;
  speed = 1;
  playing = false;
  /** Confirmed events from vetted triggers. */
  events: DetectedEvent[] = [];
  /** Current provisional event from raw picks. */
  early: EarlyEvent | null = null;
  /** First provisional declaration: when (scenario ms) and where. */
  declared: { at: number; event: EarlyEvent } | null = null;
  /** When the first confirmed event formed (scenario ms). */
  confirmedAt: number | null = null;
  /** Provisional alerts that later fell apart (should never happen without a quake). */
  withdrawn = 0;
  arrivedTriggers: Trigger[] = [];
  private queue: Arrival[] = [];
  private next = 0;
  private picks = new Map<string, Trigger>();
  private raf = 0;
  private last = 0;

  load(s: Scenario) {
    this.pause();
    const start = s.truth?.date ? Date.parse(s.truth.date) - ORIGIN_OFFSET_S * 1000 : Date.UTC(2025, 6, 4, 21, 30);
    const sim = simulate(s, start);
    this.sim = sim;
    this.queue = [];
    this.nodes = sim.nodes.map((n) => {
      const bp = [new Bandpass(1, 10, FS), new Bandpass(1, 10, FS), new Bandpass(1, 10, FS)];
      const trace = new Float32Array(n.samples.length);
      n.samples.forEach((smp, i) => {
        trace[i] = Math.hypot(bp[0].step(smp.x), bp[1].step(smp.y), bp[2].step(smp.z));
      });
      trace.fill(0, 0, FS);
      const view: ReplayNodeView = { id: n.id, lat: n.lat, lon: n.lon, distKm: n.distKm, trace, picks: [], trigger: null, rejects: [] };
      for (const o of n.outputs) {
        const tr: Trigger = { id: `${n.id}@${o.t}`, node: n.id, lat: n.lat, lon: n.lon, t: o.t, pga: o.kind === 'trigger' ? o.pga : 0, phase: o.kind === 'reject' ? undefined : o.phase };
        const rel = { t: o.t - start, at: o.at - start };
        if (o.kind === 'pick') view.picks.push({ ...rel, phase: o.phase });
        else if (o.kind === 'trigger') view.trigger ??= { ...rel, pga: o.pga };
        else view.rejects.push({ ...rel, reason: o.reason });
        this.queue.push({ at: rel.at + RELAY_LATENCY_MS, kind: o.kind === 'reject' ? 'retract' : o.kind, tr });
      }
      return view;
    });
    this.queue.sort((a, b) => a.at - b.at);
    this.seek(0);
  }

  get duration() {
    return (this.sim?.durationS ?? 0) * 1000;
  }

  /** Seconds since origin time (negative before the quake). */
  get sinceOrigin() {
    return this.vt / 1000 - ORIGIN_OFFSET_S;
  }

  play() {
    if (!this.sim || this.playing) return;
    if (this.vt >= this.duration) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    const step = (now: number) => {
      if (!this.playing) return;
      this.advance(Math.min(now - this.last, 1000) * this.speed);
      this.last = now;
      if (this.vt >= this.duration) this.pause();
      else this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.emit();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  seek(vt: number) {
    this.vt = 0;
    this.next = 0;
    this.picks.clear();
    this.arrivedTriggers = [];
    this.events = [];
    this.early = null;
    this.declared = null;
    this.confirmedAt = null;
    this.withdrawn = 0;
    this.advance(Math.max(0, Math.min(vt, this.duration)));
  }

  advance(dtMs: number) {
    const sim = this.sim;
    if (!sim) return;
    this.vt = Math.min(this.vt + dtMs, this.duration);
    let picksChanged = false;
    let triggersChanged = false;
    while (this.next < this.queue.length && this.queue[this.next].at <= this.vt) {
      const a = this.queue[this.next++];
      if (a.kind === 'trigger') {
        this.arrivedTriggers.push(a.tr);
        triggersChanged = true;
        if (this.confirmedAt === null) {
          this.events = associate(this.arrivedTriggers);
          if (this.events.length) this.confirmedAt = a.at;
        }
        continue;
      }
      if (a.kind === 'pick') this.picks.set(a.tr.id, a.tr);
      else this.picks.delete(a.tr.id);
      picksChanged = true;
      // Until the first declaration, evaluate after every single arrival so its time is exact.
      if (!this.declared) this.evaluateEarly(a.at);
    }
    if (triggersChanged && this.confirmedAt !== null) this.events = associate(this.arrivedTriggers);
    if (picksChanged && this.declared) this.evaluateEarly(this.vt);
    this.emit();
  }

  private evaluateEarly(at: number) {
    const evs = earlyDetect([...this.picks.values()], this.nodes, this.sim!.start + at);
    const was = this.early;
    this.early = evs[0] ?? null;
    if (this.early && !this.declared) this.declared = { at, event: this.early };
    if (was && !this.early && !this.events.length) this.withdrawn++;
  }

  /** Warning-time analysis for the first declaration (needs a real quake). */
  warning(): WarningSummary | null {
    const truth = this.sim?.scenario.truth;
    if (!truth || !this.declared) return null;
    const phones = this.sim!.nodes.map((n) => ({ lat: n.lat, lon: n.lon, pga: n.pga }));
    return warningSummary(phones, truth, truth.depthKm, this.declared.at / 1000 - ORIGIN_OFFSET_S, RELAY_LATENCY_MS / 1000);
  }

  /** Current shaking at a node (0..1 for display). */
  shake(n: ReplayNodeView) {
    const i = Math.floor((this.vt / 1000) * FS);
    let m = 0;
    for (let k = Math.max(0, i - 10); k <= i && k < n.trace.length; k++) m = Math.max(m, n.trace[k]);
    return Math.min(1, m / 1.2);
  }

  waves() {
    const t = this.sim?.scenario.truth;
    const s = this.sinceOrigin;
    if (!t || s <= 0) return null;
    const surf = (v: number) => Math.sqrt(Math.max(0, (v * s) ** 2 - t.depthKm ** 2));
    return { center: t, pKm: surf(VP_KMS), sKm: surf(VS_KMS) };
  }
}
