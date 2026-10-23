import type { PhoneWarning } from '../core/impact';
import { many } from './format';

const s1 = (x: number) => Math.abs(x).toFixed(1);

/** What the warning was for the phones near a named place, in plain words. */
export function nearLine(place: string, epicentreKm: number, near: { n: number; min: number; max: number; warned: number } | null, radiusKm: number): string {
  const head = `Near ${place} (${Math.round(epicentreKm)} km from the epicentre):`;
  if (!near) return `${head} no simulated phone within ${radiusKm} km felt it, so there is no figure for it.`;
  const who = `${many(near.n, 'phone')} within ${radiusKm} km`;
  const range = (a: number, b: number) => (s1(a) === s1(b) ? s1(a) : `${s1(a)}–${s1(b)}`);
  if (near.max <= 0) return `${head} shaking came ${range(-near.max, -near.min)} s before the alert (${who}), so no warning.`;
  if (near.min > 0) return `${head} the alert came ${range(near.min, near.max)} s before the strong shaking (${who}).`;
  return `${head} from shaking ${s1(near.min)} s before the alert to ${s1(near.max)} s of warning (${who}); ${near.warned} of ${near.n} phones was warned.`;
}

/** What a tap on one simulated phone says. */
export function phoneNote(p: PhoneWarning, alerted: boolean): string {
  const head = `Simulated phone, ${p.epicentreKm.toFixed(1)} km from the epicentre.`;
  if (!alerted) return `${head} No alert yet, so no warning time yet.`;
  if (!p.felt) return `${head} It barely felt the quake.`;
  return p.s > 0 ? `${head} The alert reached it ${s1(p.s)} s before the strong shaking.` : `${head} The strong shaking reached it ${s1(p.s)} s before the alert: no warning.`;
}
