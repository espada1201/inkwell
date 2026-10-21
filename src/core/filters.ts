/**
 * Second-order IIR sections (RBJ audio-EQ cookbook, Q = 1/sqrt(2) gives Butterworth).
 * Phones deliver 50–100 Hz motion samples; earthquake shaking that phones can feel
 * sits roughly in 1–10 Hz, so a bandpass removes gravity/tilt drift and handling buzz.
 */
export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(
    readonly b0: number,
    readonly b1: number,
    readonly b2: number,
    readonly a1: number,
    readonly a2: number,
  ) {}

  static lowpass(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * fc) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + alpha;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - alpha) / a0);
  }

  static highpass(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * fc) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + alpha;
    return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - alpha) / a0);
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  /** Analytic magnitude response |H(e^{jw})| at frequency f. */
  gain(f: number, fs: number): number {
    const w = (2 * Math.PI * f) / fs;
    const re = (b: number[]) => b[0] + b[1] * Math.cos(-w) + b[2] * Math.cos(-2 * w);
    const im = (b: number[]) => b[1] * Math.sin(-w) + b[2] * Math.sin(-2 * w);
    const num = [this.b0, this.b1, this.b2];
    const den = [1, this.a1, this.a2];
    return Math.hypot(re(num), im(num)) / Math.hypot(re(den), im(den));
  }
}

export class Bandpass {
  private readonly hp: Biquad;
  private readonly lp: Biquad;
  constructor(lo: number, hi: number, fs: number) {
    this.hp = Biquad.highpass(lo, fs);
    this.lp = Biquad.lowpass(Math.min(hi, fs * 0.45), fs);
  }
  step(x: number): number {
    return this.lp.step(this.hp.step(x));
  }
  gain(f: number, fs: number): number {
    return this.hp.gain(f, fs) * this.lp.gain(f, fs);
  }
}

/** One-pole low-pass used to track the slowly changing gravity vector. */
export class OnePole {
  private y: number | undefined;
  private readonly k: number;
  constructor(tauS: number, fs: number) {
    this.k = 1 - Math.exp(-1 / (tauS * fs));
  }
  step(x: number): number {
    this.y = this.y === undefined ? x : this.y + this.k * (x - this.y);
    return this.y;
  }
}
