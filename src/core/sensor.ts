import { Bandpass, OnePole } from './filters';
import { G, type Phase } from './physics';
import { upperMedian } from './stats';

export interface Sample {
  /** ms since epoch */
  t: number;
  /** accelerationIncludingGravity, m/s² */
  x: number;
  y: number;
  z: number;
}

/** Why a phone withdrew its pick. Interrupted: the samples stopped before it could tell. */
export type RejectReason = 'handling' | 'impulse' | 'footsteps' | 'interrupted';

export type DetectorOutput =
  /**
   * Provisional: shaking just started. Sent 0.4 s after the onset it marks so the network can react
   * fast: typically 0.5–1 s after the shaking reached the phone, up to 2 s when it was barely felt.
   */
  | { kind: 'pick'; t: number; at: number; phase: Phase }
  | { kind: 'trigger'; t: number; at: number; phase: Phase; pga: number; durS: number }
  | { kind: 'reject'; t: number; at: number; reason: RejectReason };

export interface DetectorOptions {
  staS?: number;
  ltaS?: number;
  /** Base STA/LTA energy ratio that opens a candidate. Adapts upward after false alarms. */
  thresholdOn?: number;
  /** Shaking below this RMS (m/s²) is ignored regardless of ratio: phone noise floor. */
  floor?: number;
  warmupS?: number;
  /** Seconds of motion after the onset used to tell a P wave from an S wave. */
  phaseS?: number;
}

const DEG = 180 / Math.PI;

/**
 * Per-phone earthquake trigger.
 *  1. Track gravity with a slow low-pass (also tells us the phone's orientation).
 *  2. Bandpass each axis 1–10 Hz and take the vector magnitude.
 *  3. Recursive STA/LTA on signal energy opens a candidate. 0.4 s later a provisional "pick" goes
 *     out so the network can act fast, labelled with the wave that opened it:
 *     P waves shake the ground mostly up and down, S waves mostly side to side, and gravity
 *     tells the phone which way is down however it lies.
 *  4. The candidate is judged once shaking has died down, against the background from before
 *     the onset: phone rotated → handling; four or more bursts, mostly under a second each →
 *     footsteps; under a second of strong motion, or under 0.7 s a burst → impulse (door slam,
 *     bump, a few knocks). Survivors trigger, with the onset time of the first arrival.
 * Each false alarm raises the threshold, which relaxes back over a couple of minutes.
 */
export class NodeDetector {
  readonly fs: number;
  readonly base: number;
  threshold: number;
  readonly floor: number;
  ratio = 0;
  /** Latest bandpassed acceleration magnitude, m/s². */
  level = 0;
  private sta = 0;
  private lta = 0;
  private n = 0;
  private readonly kSta: number;
  private readonly kLta: number;
  private readonly warmup: number;
  private readonly phaseMs: number;
  private grav: OnePole[] = [];
  private bp: Bandpass[] = [];
  /** This run's first sample. */
  private origin: number[] | null = null;
  private readonly env: OnePole;
  private lastT = 0;
  private holdUntil = 0;
  private cand: {
    t0: number;
    g0: [number, number, number];
    /** Unit vector pointing down, and vertical vs horizontal energy since the onset. */
    down: [number, number, number];
    ev: number;
    eh: number;
    phase: Phase | null;
    lastLoud: number;
    peak: number;
    peakEnv: number;
    maxTilt: number;
    envs: number[];
  } | null = null;
  private gNow: [number, number, number] = [0, 0, G];
  private gHist: [number, number, number][] = [];

  constructor(fs: number, o: DetectorOptions = {}) {
    this.fs = fs;
    this.kSta = 1 / ((o.staS ?? 0.4) * fs);
    this.kLta = 1 / ((o.ltaS ?? 20) * fs);
    this.base = this.threshold = o.thresholdOn ?? 5;
    this.floor = o.floor ?? 0.04;
    this.warmup = (o.warmupS ?? 5) * fs;
    this.phaseMs = (o.phaseS ?? 0.4) * 1000;
    this.env = new OnePole(0.08, fs);
    this.reset();
  }

  get warmingUp(): boolean {
    return this.n < this.warmup;
  }

  /** RMS of the bandpassed shaking over the last LTA seconds of quiet, m/s² (frozen while a candidate is checked). */
  get background(): number {
    return Math.sqrt(this.lta);
  }

  /** The shaking clears the trigger now: STA/LTA over the threshold, and RMS over the floor. */
  get overTrigger(): boolean {
    return this.ratio > this.threshold && Math.sqrt(this.sta) > this.floor;
  }

  /** RMS shaking that would open a candidate now, m/s²: the threshold over the background, and never below the floor. */
  get triggerLevel(): number {
    return Math.max(Math.sqrt(this.threshold) * this.background, this.floor);
  }

  /**
   * Peak acceleration of quake shaking this phone notices now, m/s² (rough): of 3000 synthetic
   * quakes, all whose PGA reached 2.5 times the trigger level were noticed, 65% at 2–2.25 times.
   */
  get noticesPga(): number {
    return 2.5 * this.triggerLevel;
  }

  /** The samples stop here: start afresh, and withdraw a pick already sent for shaking still being checked. */
  interrupt(t: number): DetectorOutput | null {
    const lost = this.cand;
    this.reset();
    return lost?.phase ? { kind: 'reject', t: lost.t0, at: t, reason: 'interrupted' } : null;
  }

  push(s: Sample): DetectorOutput | null {
    if (this.lastT && Math.abs(s.t - this.lastT) > 1000) {
      // The samples stopped for a while, as in a hidden tab, or the clock was set.
      const out = this.interrupt(s.t);
      if (out) {
        this.lastT = s.t;
        return out;
      }
    }
    const dtS = this.lastT ? (s.t - this.lastT) / 1000 : 1 / this.fs;
    this.lastT = s.t;
    // Threshold relaxes toward base with a 2-minute time constant.
    this.threshold = this.base + (this.threshold - this.base) * Math.exp(-dtS / 120);

    const raw = [s.x, s.y, s.z];
    this.gNow = raw.map((v, i) => this.grav[i].step(v)) as [number, number, number];
    if (this.n % Math.round(this.fs / 4) === 0) {
      this.gHist.push(this.gNow);
      if (this.gHist.length > 8) this.gHist.shift();
    }
    // Filter the change since this run's first sample: the filters start from rest, so gravity
    // switching on is no burst of shaking for the background to learn.
    const o = (this.origin ??= raw);
    const f = raw.map((v, i) => this.bp[i].step(v - o[i]));
    const e = f[0] * f[0] + f[1] * f[1] + f[2] * f[2];
    const a = Math.sqrt(e);
    this.level = a;
    const env = this.env.step(a);

    this.n++;
    // Skip the first second so the filters' start-up transient never reaches the averages.
    const m = this.n - this.fs;
    if (m <= 0) return null;
    this.sta += (e - this.sta) * Math.max(this.kSta, 1 / m);
    if (!this.cand) this.lta += (e - this.lta) * Math.max(this.kLta, 1 / m);
    this.ratio = this.lta > 0 ? this.sta / this.lta : 0;
    if (this.warmingUp) return null;

    if (!this.cand) {
      if (s.t >= this.holdUntil && this.overTrigger) {
        const g0 = this.gHist[0] ?? this.gNow;
        const gm = Math.hypot(...g0) || 1;
        this.cand = { t0: s.t, g0, down: [g0[0] / gm, g0[1] / gm, g0[2] / gm], ev: 0, eh: 0, phase: null, lastLoud: s.t, peak: a, peakEnv: env, maxTilt: 0, envs: [env] };
        this.polarize(f, e);
      }
      return null;
    }
    const c = this.cand;
    if (!c.phase) {
      this.polarize(f, e);
      if (s.t - c.t0 >= this.phaseMs) {
        c.phase = c.ev >= c.eh ? 'P' : 'S';
        return { kind: 'pick', t: c.t0, at: s.t, phase: c.phase };
      }
    }
    c.peak = Math.max(c.peak, a);
    c.peakEnv = Math.max(c.peakEnv, env);
    c.maxTilt = Math.max(c.maxTilt, angle(c.g0, this.gNow));
    c.envs.push(env);
    if (env > Math.max(0.15 * c.peakEnv, 1.5 * this.background)) c.lastLoud = s.t;
    // Keep listening at least 15 s so a late, stronger S wave still counts toward the peak, and
    // judge by 30 s: now, if the next sample would come later than that.
    const open = s.t - c.t0;
    if (open + dtS * 1000 <= 30000 && (open < 15000 || s.t - c.lastLoud < 3000)) return null;
    return this.judge(s.t);
  }

  private judge(t: number): DetectorOutput {
    const c = this.cand!;
    this.cand = null;
    // Seconds of strong envelope, and the separate bursts it came in. Strong is a share of the
    // peak and clearly above the background from before the onset (the LTA stays frozen while a
    // candidate is open): a knock that only just crossed the trigger peaks at a few times the
    // background, so shares of its peak alone fall inside the noise and it seems to go on and on.
    const bg = this.background;
    const loud = Math.max(0.25 * c.peakEnv, 1.5 * bg);
    const on = Math.max(0.5 * c.peakEnv, 2.5 * bg);
    const off = Math.max(0.2 * c.peakEnv, bg);
    let active = 0;
    const bursts: number[] = [];
    let start = -1;
    c.envs.forEach((v, i) => {
      if (v > loud) active++;
      if (start < 0 && v > on) start = i;
      else if (start >= 0 && v < off) {
        bursts.push(i - start);
        start = -1;
      }
    });
    if (start >= 0) bursts.push(c.envs.length - start);
    const activeS = active / this.fs;
    // Footsteps are a train of short knocks; quake shaking comes as a few long bursts.
    const typicalBurstS = (upperMedian(bursts) ?? 0) / this.fs;

    let reason: RejectReason | null = null;
    if (c.maxTilt > 5) reason = 'handling';
    else if (bursts.length >= 4 && typicalBurstS < 1) reason = 'footsteps';
    else if (activeS < Math.max(1, 0.7 * bursts.length)) reason = 'impulse';

    if (reason) {
      this.threshold = Math.min(this.threshold * 1.25, this.base * 3);
      this.holdUntil = t + (reason === 'handling' ? 30000 : 2000);
      return { kind: 'reject', t: c.t0, at: t, reason };
    }
    this.holdUntil = t + 10000;
    // shortcut: footsteps still being checked when a quake arrives are confirmed with the
    // footsteps' onset time; split the candidate at a fresh onset if replays show early outliers.
    return { kind: 'trigger', t: c.t0, at: t, phase: c.phase ?? 'P', pga: c.peak, durS: activeS };
  }

  private polarize(f: number[], e: number) {
    const c = this.cand!;
    const v = f[0] * c.down[0] + f[1] * c.down[1] + f[2] * c.down[2];
    c.ev += v * v;
    c.eh += e - v * v;
  }

  /** Start afresh: gravity, filters and averages all learn again from the next sample. */
  private reset() {
    this.n = 0;
    this.sta = this.lta = 0;
    this.cand = null;
    this.gHist = [];
    this.grav = [0, 1, 2].map(() => new OnePole(2, this.fs));
    this.bp = [0, 1, 2].map(() => new Bandpass(1, 10, this.fs));
    this.origin = null;
  }
}

function angle(a: number[], b: number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const m = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]);
  return m ? Math.acos(Math.max(-1, Math.min(1, dot / m))) * DEG : 0;
}
