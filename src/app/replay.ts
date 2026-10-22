import type { DetectedEvent, Trigger } from '../core/associate';
import { confirmedEvents, earlyDetect, type EarlyEvent, type Onset } from '../core/early';
import { Bandpass } from '../core/filters';
import { warningSummary, type WarningSummary } from '../core/impact';
import { VP_KMS, VS_KMS, waveRadiusKm, type Phase } from '../core/physics';
import { FS, ORIGIN_OFFSET_S, simulate, sinceOrigin, type Scenario, type Simulation } from '../core/scenarios';
import type { RejectReason } from '../core/sensor';
import type { NodeState } from '../ui/map';
import { Emitter } from './emitter';

export interface ReplayNodeView {
  id: string;
  lat: number;
  lon: number;
  distKm: number | null;
  /** Bandpassed shaking magnitude per sample, m/s². */
  trace: Float32Array;
  /** Scenario-relative ms (onset t, sent at), and the wave the phone felt. */
  picks: { t: number; at: number; phase: Phase }[];
  trigger: { t: number; at: number; pga: number; phase: Phase } | null;
  rejects: { t: number; at: number; reason: RejectReason }[];
}

/** What a browser watching the relays receives, in order. */
interface Arrival {
  at: number;
  kind: 'pick' | 'retract' | 'trigger';
  tr: Trigger;
}

/** Assumed phone → relay → browser latency, ms. */
export const RELAY_LATENCY_MS = 1000;
/** A withdrawn pick stays drawn as withdrawn this long. */
const WITHDRAWN_SHOWN_MS = 8000;

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
  /** When the first pick went out (scenario ms): the first from the quake itself, or any without one. */
  firstPickAt: number | null = null;
  private arrivedTriggers: Trigger[] = [];
  private queue: Arrival[] = [];
  private next = 0;
  private picks = new Map<string, Trigger>();
  /** Onsets heard so far: picks, withdrawn or not, and triggers. */
  private heard: Onset[] = [];
  /** A provisional candidate holds for now, but phones the wave is still reaching could overturn it. */
  private waiting = false;
  private lastEval = 0;
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
        else if (o.kind === 'trigger') view.trigger ??= { ...rel, pga: o.pga, phase: o.phase };
        else view.rejects.push({ ...rel, reason: o.reason });
        this.queue.push({ at: rel.at + RELAY_LATENCY_MS, kind: o.kind === 'reject' ? 'retract' : o.kind, tr });
      }
      return view;
    });
    this.queue.sort((a, b) => a.at - b.at);
    const after = s.truth ? ORIGIN_OFFSET_S * 1000 : -Infinity;
    const first = Math.min(...this.nodes.flatMap((n) => n.picks.filter((p) => p.t >= after).map((p) => p.at)));
    this.firstPickAt = Number.isFinite(first) ? first : null;
    this.seek(0);
  }

  get duration() {
    return (this.sim?.durationS ?? 0) * 1000;
  }

  /** The replay clock at scenario ms `at`, s: since the quake's origin (negative before it), or since the start when there is no quake. */
  clockAt(at: number) {
    return this.sim?.scenario.truth ? sinceOrigin(at) : at / 1000;
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
    // Frame handles are never 0, so this skips nothing scheduled, and a Replay runs without a browser.
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit();
  }

  seek(vt: number) {
    this.vt = 0;
    this.next = 0;
    this.picks.clear();
    this.heard = [];
    this.waiting = false;
    this.lastEval = 0;
    this.arrivedTriggers = [];
    this.events = [];
    this.early = null;
    this.declared = null;
    this.confirmedAt = null;
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
      this.catchUp(a.at);
      if (a.kind === 'trigger') {
        this.arrivedTriggers.push(a.tr);
        this.heard.push(a.tr);
        triggersChanged = true;
        if (this.confirmedAt === null) {
          this.events = this.confirmed(a.at);
          if (this.events.length) this.confirmedAt = a.at;
        }
        continue;
      }
      if (a.kind === 'pick') {
        this.picks.set(a.tr.id, a.tr);
        this.heard.push(a.tr);
      } else this.picks.delete(a.tr.id);
      picksChanged = true;
      // Until the first declaration, evaluate after every single arrival so its time is exact.
      if (!this.declared) this.evaluateEarly(a.at);
    }
    this.catchUp(this.vt);
    if (triggersChanged && this.confirmedAt !== null) this.events = this.confirmed(this.vt);
    if (picksChanged && this.declared) this.evaluateEarly(this.vt);
    this.emit();
  }

  /** While a candidate waits on quiet phones, look again every 100 ms of scenario time. */
  private catchUp(to: number) {
    while (!this.declared && this.waiting && this.lastEval + 100 <= to) this.evaluateEarly(this.lastEval + 100);
  }

  /** Events located from the vetted triggers so far that the quiet phones do not contradict. */
  private confirmed(at: number) {
    return confirmedEvents(this.arrivedTriggers, this.heard, () => this.nodes, this.sim!.start + at);
  }

  private evaluateEarly(at: number) {
    const r = earlyDetect([...this.picks.values()], this.nodes, this.sim!.start + at);
    this.early = r.events[0] ?? null;
    this.waiting = r.waiting;
    this.lastEval = at;
    if (this.early && !this.declared) this.declared = { at, event: this.early };
  }

  /** Warning-time analysis for the first declaration (needs a real quake). */
  warning(): WarningSummary | null {
    const truth = this.sim?.scenario.truth;
    if (!truth || !this.declared) return null;
    const phones = this.sim!.nodes.map((n) => ({ lat: n.lat, lon: n.lon, pga: n.pga }));
    return warningSummary(phones, truth, truth.depthKm, sinceOrigin(this.declared.at), RELAY_LATENCY_MS / 1000);
  }

  /** How a phone is drawn now: confirmed, withdrawn a moment ago, still checking a pick, or idle. */
  nodeState(n: ReplayNodeView): NodeState {
    const vt = this.vt;
    if (n.trigger && n.trigger.at <= vt) return 'trigger';
    if (n.rejects.some((x) => x.at <= vt && vt - x.at < WITHDRAWN_SHOWN_MS)) return 'reject';
    const pick = n.picks.filter((p) => p.at <= vt).pop();
    if (!pick) return 'idle';
    // Only the latest pick's own verdict ends its check, not one on an earlier pick.
    const verdict = n.trigger?.t === pick.t ? n.trigger : n.rejects.find((x) => x.t === pick.t);
    return verdict && verdict.at <= vt ? 'idle' : 'pick';
  }

  /** Phones whose own checks confirmed their shaking so far, and the picks phones withdrew so far, in all and by reason. */
  counts() {
    const why = new Map<RejectReason, number>();
    for (const n of this.nodes) for (const x of n.rejects) if (x.at <= this.vt) why.set(x.reason, (why.get(x.reason) ?? 0) + 1);
    return { confirmed: this.nodes.filter((n) => n.trigger && n.trigger.at <= this.vt).length, withdrawn: [...why.values()].reduce((a, b) => a + b, 0), why };
  }

  /** Current shaking at a node (0..1 for display). */
  shake(n: ReplayNodeView) {
    const i = Math.floor((this.vt / 1000) * FS);
    let m = 0;
    for (let k = Math.max(0, i - 10); k <= i && k < n.trace.length; k++) m = Math.max(m, n.trace[k]);
    return Math.min(1, m / 1.2);
  }

  /** 0..1: the strongest shaking any phone feels right now. */
  activity() {
    return this.nodes.reduce((m, n) => Math.max(m, this.shake(n)), 0);
  }

  waves() {
    const t = this.sim?.scenario.truth;
    const s = sinceOrigin(this.vt);
    if (!t || s <= 0) return null;
    return { center: t, pKm: waveRadiusKm(VP_KMS, s, t.depthKm), sKm: waveRadiusKm(VS_KMS, s, t.depthKm) };
  }
}
