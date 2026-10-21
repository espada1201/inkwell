import { describe, expect, it } from 'vitest';
import { Bandpass, Biquad } from '../../src/core/filters';

const fs = 50;
function measuredGain(filter: { step(x: number): number }, f: number) {
  let peak = 0;
  for (let i = 0; i < fs * 20; i++) {
    const y = filter.step(Math.sin((2 * Math.PI * f * i) / fs));
    if (i > fs * 10) peak = Math.max(peak, Math.abs(y));
  }
  return peak;
}

describe('biquad filters', () => {
  it('Butterworth low-pass is -3 dB at the corner and matches its analytic response', () => {
    const lp = Biquad.lowpass(5, fs);
    expect(lp.gain(5, fs)).toBeCloseTo(Math.SQRT1_2, 3);
    for (const f of [0.5, 2, 5, 12, 20]) expect(measuredGain(Biquad.lowpass(5, fs), f)).toBeCloseTo(lp.gain(f, fs), 2);
  });

  it('high-pass blocks gravity (DC) and passes shaking', () => {
    const hp = Biquad.highpass(1, fs);
    let y = 0;
    for (let i = 0; i < fs * 30; i++) y = hp.step(9.81);
    expect(Math.abs(y)).toBeLessThan(1e-6);
    expect(hp.gain(5, fs)).toBeGreaterThan(0.95);
  });

  it('1–10 Hz bandpass keeps quake band, rejects drift', () => {
    const bp = new Bandpass(1, 10, fs);
    expect(bp.gain(3, fs)).toBeGreaterThan(0.9);
    expect(bp.gain(0.1, fs)).toBeLessThan(0.02);
    expect(bp.gain(24, fs)).toBeLessThan(0.15);
  });
});
