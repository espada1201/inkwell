import type { Phase } from './physics';
import { rng } from './rng';
import { NodeDetector, type DetectorOutput } from './sensor';
import { FS, codaS, phoneNoise } from './simnet';
import { synthesize } from './synth';

/**
 * A simulated phone's measured behaviour, for when there are too many phones and quakes to
 * synthesise sample by sample. `calibrate` runs the real on-device detector over synthetic
 * records across shaking levels and S−P times; `respond` then draws one phone's outcome
 * (noticed or not, how late, confirmed or retracted) from those runs.
 */

const PGA_LEVELS = [0.005, 0.01, 0.02, 0.035, 0.06, 0.1, 0.18, 0.3, 0.55, 1, 1.8, 3.2];
const SP_LEVELS = [1, 2.5, 5, 9];
const RUNS = 6;

interface Response {
  /** Seconds from the P arrival to the onset the phone picked; null when it never noticed. */
  delay: number | null;
  /** The wave the phone said it felt. */
  phase: Phase;
  /** Seconds from the onset until the pick went out. */
  sent: number;
  /** Seconds from the onset to the phone's verdict. */
  vet: number;
  confirmed: boolean;
  /** Measured peak over true peak acceleration. */
  gain: number;
}

export interface PhoneModel {
  /** [shaking level][S−P time][run] */
  cells: Response[][][];
}

/** Measure the real phone detector on synthetic quakes of this magnitude (about a second of work). */
export function calibrate(mag: number): PhoneModel {
  const r = rng(Math.round(mag * 1000));
  const tP = 12;
  const cells = PGA_LEVELS.map((pga) =>
    SP_LEVELS.map((sp) =>
      Array.from({ length: RUNS }, (): Response => {
        const det = new NodeDetector(FS);
        const record = synthesize({
          fs: FS,
          start: 0,
          durationS: tP + sp + 32,
          seed: Math.floor(r() * 2 ** 31),
          noise: phoneNoise(r),
          quake: { tP, tS: tP + sp, pga, decayS: codaS(mag) },
        });
        let pick: Extract<DetectorOutput, { kind: 'pick' }> | null = null;
        for (const s of record) {
          const o = det.push(s);
          if (!o) continue;
          if (o.kind === 'pick') {
            if (pick === null && o.t >= (tP - 1) * 1000) pick = o;
          } else if (pick && o.t === pick.t) {
            const sent = (pick.at - pick.t) / 1000;
            return { delay: pick.t / 1000 - tP, phase: pick.phase, sent, vet: (o.at - pick.t) / 1000, confirmed: o.kind === 'trigger', gain: o.kind === 'trigger' ? o.pga / pga : 1 };
          }
        }
        return { delay: null, phase: 'P', sent: 0, vet: 0, confirmed: false, gain: 1 };
      }),
    ),
  );
  return { cells };
}

/** Draw one phone's behaviour for a given true shaking level and S−P time. */
export function respond(m: PhoneModel, pga: number, sp: number, r: () => number): Response {
  const lp = Math.log(pga);
  let i = 0;
  while (i < PGA_LEVELS.length - 1 && Math.log(PGA_LEVELS[i + 1]) <= lp) i++;
  // Between two measured levels: choose one at random, weighted by closeness in log PGA.
  if (i < PGA_LEVELS.length - 1 && lp > Math.log(PGA_LEVELS[i])) {
    const f = (lp - Math.log(PGA_LEVELS[i])) / (Math.log(PGA_LEVELS[i + 1]) - Math.log(PGA_LEVELS[i]));
    if (r() < f) i++;
  }
  let j = 0;
  SP_LEVELS.forEach((v, k) => Math.abs(v - sp) < Math.abs(SP_LEVELS[j] - sp) && (j = k));
  const runs = m.cells[i][j];
  const out = runs[Math.floor(r() * runs.length)];
  // A pick made on the S wave moves with this phone's own S−P time.
  return out.delay !== null && out.phase === 'S' ? { ...out, delay: out.delay - SP_LEVELS[j] + sp } : out;
}
