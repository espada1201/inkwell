import { intensityLevel } from '../core/physics';

/** Display formats, one home each, so every screen writes a number the same way. */

const hemisphere = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;
export const lat = (v: number) => hemisphere(v, 'N', 'S');
export const lon = (v: number) => hemisphere(v, 'E', 'W');
export const coord = (la: number, lo: number) => `${lat(la)} ${lon(lo)}`;

export const mag = (m: number | null | undefined) => (m === null || m === undefined ? 'M ?' : `M${m.toFixed(1)}`);
/** A magnitude inside a list badge: the number alone. */
export const magBadge = (m: number | null) => (m === null ? '?' : m.toFixed(1));

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

export const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
export const secs = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} s`);
export const km = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} km`);

/** Felt intensity in words, by level (see `intensityLevel`). */
export const INTENSITY_WORDS = ['not felt', 'weak', 'light', 'moderate', 'strong', 'very strong', 'severe'] as const;
/** Roughly how a peak acceleration feels, in words. */
export const intensityWord = (pga: number) => INTENSITY_WORDS[intensityLevel(pga)];

/** Seconds from a quake's origin on a replay clock: T−3.0 s, T+12.4 s. */
export const clockT = (s: number) => `${s < 0 ? 'T−' : 'T+'}${Math.abs(s).toFixed(1)} s`;
