import { Bandpass } from './filters';
import { gauss, rng } from './rng';
import type { Sample } from './sensor';

export interface SynthOptions {
  fs?: number;
  /** ms since epoch of the first sample */
  start: number;
  durationS: number;
  seed: number;
  /** Background accelerometer noise per axis, m/s² RMS. */
  noise?: number;
  /** Seconds after start; pga in m/s². */
  quake?: { tP: number; tS: number; pga: number; decayS?: number };
  footsteps?: { t: number; count: number; interval?: number; amp?: number };
  slam?: { t: number; amp?: number };
  /** The phone is picked up and tilted by `deg` over one second. */
  pickup?: { t: number; deg?: number };
}

/** Band-limited noise burst with an attack/decay envelope, scaled to the requested peak. */
function burst(n: number, fs: number, r: () => number, lo: number, hi: number, at: number, rise: number, decay: number, peak: number) {
  const bp = new Bandpass(lo, hi, fs);
  const out = new Float64Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const w = bp.step(gauss(r));
    const dt = i / fs - at;
    const env = dt < 0 ? 0 : dt < rise ? dt / rise : Math.exp(-(dt - rise) / decay);
    out[i] = w * env;
    max = Math.max(max, Math.abs(out[i]));
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] *= peak / max;
  return out;
}

function ring(out: Float64Array, fs: number, at: number, freq: number, tau: number, amp: number) {
  const i0 = Math.round(at * fs);
  for (let i = Math.max(0, i0); i < out.length && i < i0 + tau * 8 * fs; i++) {
    const dt = (i - i0) / fs;
    out[i] += amp * Math.exp(-dt / tau) * Math.sin(2 * Math.PI * freq * dt);
  }
}

/** Synthetic three-axis phone accelerometer record (gravity included, phone flat on a table). */
export function synthesize(o: SynthOptions): Sample[] {
  const fs = o.fs ?? 50;
  const n = Math.round(o.durationS * fs);
  const r = rng(o.seed);
  const noise = o.noise ?? 0.012;
  const ax = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (const a of ax) for (let i = 0; i < n; i++) a[i] = noise * gauss(r);

  if (o.quake) {
    const q = o.quake;
    const decay = q.decayS ?? 4;
    // P: compressional, mostly vertical, smaller and higher-frequency.
    const p = burst(n, fs, r, 2, 8, q.tP, 0.15, Math.min(1.5, (q.tS - q.tP) * 0.6 + 0.3), 0.35 * q.pga);
    // S: shear, horizontal, the strong shaking.
    const sx = burst(n, fs, r, 1, 5, q.tS, 0.5, decay, 0.75 * q.pga);
    const sy = burst(n, fs, r, 1, 5, q.tS, 0.5, decay, 0.75 * q.pga);
    for (let i = 0; i < n; i++) {
      ax[2][i] += p[i] + 0.25 * sx[i];
      ax[0][i] += sx[i] + 0.2 * p[i];
      ax[1][i] += sy[i];
    }
  }
  if (o.footsteps) {
    const f = o.footsteps;
    for (let k = 0; k < f.count; k++) {
      const at = f.t + k * (f.interval ?? 0.55) + 0.04 * gauss(r);
      ring(ax[2], fs, at, 7, 0.04, f.amp ?? 0.35);
      ring(ax[0], fs, at, 7, 0.04, (f.amp ?? 0.35) * 0.3);
    }
  }
  if (o.slam) for (const a of ax) ring(a, fs, o.slam.t, 6, 0.1, (o.slam.amp ?? 1.2) * (0.5 + r()));

  const samples: Sample[] = [];
  const tiltRad = ((o.pickup?.deg ?? 35) * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const ts = i / fs;
    let th = 0;
    // Held in a hand: tilted, and never quite still.
    if (o.pickup && ts > o.pickup.t) th = tiltRad * Math.min(1, ts - o.pickup.t) + 0.07 * Math.sin(ts * 3);
    const handJiggle = o.pickup && ts > o.pickup.t ? 0.3 * Math.sin(ts * 9) + 0.2 * gauss(r) : 0;
    samples.push({
      t: o.start + ts * 1000,
      x: ax[0][i] + handJiggle,
      y: ax[1][i] + 9.81 * Math.sin(th),
      z: ax[2][i] + 9.81 * Math.cos(th),
    });
  }
  return samples;
}
