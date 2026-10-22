import { Bandpass, OnePole } from './filters';
import type { Phase } from './physics';

export interface Sample {
  /** ms since epoch */
  t: number;
  /** accelerationIncludingGravity, m/s² */
  x: number;
  y: number;
  z: number;
}

export type RejectReason = 'handling' | 'impulse' | 'footsteps';

export type DetectorOutput =
  /** Provisional: shaking just started. Sent within a second so the network can react fast. */
  | { kind: 'pick'; t: number; at: number; phase: Phase }
  | { kind: 'trigger'; t: number; at: number; phase: Phase; pga: number; durS: number; ratio: number }
  | { kind: 'reject'; t: number; at: number; reason: RejectReason; pga: number };

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
 *  3. Recursive STA/LTA on signal energy opens a candidate. Within half a second a provisional
 *     "pick" goes out so the network can act fast, labelled with the wave that opened it:
 *     P waves shake the ground mostly up and down, S waves mostly side to side, and gravity
 *     tells the phone which way is down however it lies.
 *  4. The candidate is judged once shaking has died down: phone rotated → handling; under a
 *     second of strong motion → impulse (door slam, bump); three or more separate bursts →
 *     footsteps. Survivors trigger, with the onset time of the first arrival.
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
  private readonly grav: OnePole[];
  private readonly bp: Bandpass[];
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
    maxRatio: number;
    maxTilt: number;
    envs: number[];
  } | null = null;
  private gNow: [number, number, number] = [0, 0, 9.81];
  private gHist: [number, number, number][] = [];

  constructor(fs: number, o: DetectorOptions = {}) {
    this.fs = fs;
    this.kSta = 1 / ((o.staS ?? 0.4) * fs);
    this.kLta = 1 / ((o.ltaS ?? 20) * fs);
    this.base = this.threshold = o.thresholdOn ?? 5;
    this.floor = o.floor ?? 0.04;
    this.warmup = (o.warmupS ?? 5) * fs;
    this.phaseMs = (o.phaseS ?? 0.4) * 1000;
    this.grav = [0, 1, 2].map(() => new OnePole(2, fs));
    this.bp = [0, 1, 2].map(() => new Bandpass(1, 10, fs));
    this.env = new OnePole(0.08, fs);
  }

  get warmingUp(): boolean {
    return this.n < this.warmup;
  }

  push(s: Sample): DetectorOutput | null {
    if (this.lastT && s.t - this.lastT > 1000) this.reset();
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
    const f = raw.map((v, i) => this.bp[i].step(v));
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
      if (s.t >= this.holdUntil && this.ratio > this.threshold && Math.sqrt(this.sta) > this.floor) {
        const g0 = this.gHist[0] ?? this.gNow;
        const gm = Math.hypot(...g0) || 1;
        this.cand = { t0: s.t, g0, down: [g0[0] / gm, g0[1] / gm, g0[2] / gm], ev: 0, eh: 0, phase: null, lastLoud: s.t, peak: a, peakEnv: env, maxRatio: this.ratio, maxTilt: 0, envs: [env] };
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
    c.maxRatio = Math.max(c.maxRatio, this.ratio);
    c.maxTilt = Math.max(c.maxTilt, angle(c.g0, this.gNow));
    c.envs.push(env);
    if (env > 0.15 * c.peakEnv) c.lastLoud = s.t;
    // Keep listening at least 15 s so a late, stronger S wave still counts toward the peak.
    const open = s.t - c.t0;
    if (open < 30000 && (open < 15000 || s.t - c.lastLoud < 3000)) return null;
    return this.judge(s.t);
  }

  private judge(t: number): DetectorOutput {
    const c = this.cand!;
    this.cand = null;
    // Seconds of strong envelope, and the separate bursts it came in (hysteresis 0.5 / 0.2 of peak).
    let active = 0;
    const bursts: number[] = [];
    let start = -1;
    c.envs.forEach((v, i) => {
      if (v > 0.25 * c.peakEnv) active++;
      if (start < 0 && v > 0.5 * c.peakEnv) start = i;
      else if (start >= 0 && v < 0.2 * c.peakEnv) {
        bursts.push(i - start);
        start = -1;
      }
    });
    if (start >= 0) bursts.push(c.envs.length - start);
    const activeS = active / this.fs;
    // Footsteps are a train of short knocks; quake shaking comes as a few long bursts.
    const typicalBurstS = median(bursts) / this.fs;

    let reason: RejectReason | null = null;
    if (c.maxTilt > 5) reason = 'handling';
    else if (activeS < 1) reason = 'impulse';
    else if (bursts.length >= 4 && typicalBurstS < 1) reason = 'footsteps';

    if (reason) {
      this.threshold = Math.min(this.threshold * 1.25, this.base * 3);
      this.holdUntil = t + (reason === 'handling' ? 30000 : 2000);
      return { kind: 'reject', t: c.t0, at: t, reason, pga: c.peak };
    }
    this.holdUntil = t + 10000;
    return { kind: 'trigger', t: c.t0, at: t, phase: c.phase ?? 'P', pga: c.peak, durS: activeS, ratio: c.maxRatio };
  }

  private polarize(f: number[], e: number) {
    const c = this.cand!;
    const v = f[0] * c.down[0] + f[1] * c.down[1] + f[2] * c.down[2];
    c.ev += v * v;
    c.eh += e - v * v;
  }

  private reset() {
    this.n = 0;
    this.sta = this.lta = 0;
    this.cand = null;
    this.gHist = [];
  }
}

function angle(a: number[], b: number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const m = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]);
  return m ? Math.acos(Math.max(-1, Math.min(1, dot / m))) * DEG : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
