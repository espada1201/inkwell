import { associate, type DetectedEvent, type Trigger } from './associate';
import { cellOf, distanceKm, type LatLon } from './geo';
import { locate } from './locate';
import { VP_KMS, VS_KMS, hypocentralKm } from './physics';

/** A phone that is listening, wherever it is. */
export interface Listener extends LatLon {
  id: string;
}

export interface JudgeOptions {
  minPicks?: number;
  /**
   * Fraction of the phones that should already have felt the quake which actually did, for a
   * cluster of `minPicks` cells. It relaxes to a third for clusters four times larger.
   */
  minAgreement?: number;
  /** Seconds of grace for clocks and relays before a quiet phone counts against an event. */
  slackS?: number;
}

export interface EarlyOptions extends JudgeOptions {
  maxRmsS?: number;
  /** Picks older than this are ignored, ms. */
  windowMs?: number;
}

export interface EarlyEvent extends DetectedEvent {
  /** Picked phones / phones that should have picked by now. */
  agreement: number;
}

export interface Verdict {
  /** Phones that felt it / phones that should have felt it by now. */
  agreement: number;
  ok: boolean;
  /** It holds for now, but the phones the wave has yet to reach could overturn it: ask again shortly. */
  waiting: boolean;
}

/** Fewer distinct cells than this is one place, where one truck, door or crowd shakes every phone. */
const MIN_CELLS = 3;

/**
 * The quiet phones' say on a candidate event (the "not-yet-arrived" idea used by real
 * early-warning systems). Every listening phone closer to the epicentre than the farthest member
 * that felt a wave should have felt that wave too, once it has had time to arrive. A handful of
 * members could be a coincidence of bumps, so nearly all of those phones must agree. Four times
 * as many cells on one wavefront cannot be a coincidence, and a weak wave is only noticed by some
 * phones, so then a third will do. Cells rather than phones, because phones in one building
 * share their bumps. Nothing is declared while the phones the wave has yet to reach could still
 * overturn the verdict by staying quiet.
 */
export function verdict(
  ev: LatLon,
  origin: number,
  members: Trigger[],
  listeners: Listener[],
  felt: Set<string>,
  now: number,
  o: JudgeOptions = {},
): Verdict {
  const minPicks = o.minPicks ?? 4;
  const minAgree = o.minAgreement ?? 0.85;
  const slack = o.slackS ?? 1.5;
  let reachP = 0;
  let reachS = 0;
  for (const m of members) {
    const d = distanceKm(ev, m);
    if (m.phase === 'S') reachS = Math.max(reachS, d);
    else reachP = Math.max(reachP, d);
  }
  let due = 0;
  let pending = 0;
  for (const n of listeners) {
    if (felt.has(n.id)) continue;
    const d = distanceKm(ev, n);
    const v = d <= reachP ? VP_KMS : d <= reachS ? VS_KMS : 0;
    if (!v) continue;
    if (origin + (hypocentralKm(d) / v + slack) * 1000 <= now) due++;
    else pending++;
  }
  const cells = new Set(members.map(cellOf)).size;
  const agreement = members.length / (members.length + due);
  const needed = minAgree - (minAgree - 1 / 3) * Math.min(1, Math.max(0, (cells - minPicks) / (3 * minPicks)));
  const passes = cells >= MIN_CELLS && agreement >= needed;
  const holds = members.length / (members.length + due + pending) >= needed;
  return { agreement, ok: passes && holds, waiting: passes && !holds };
}

/** Of the listening phones inside the members' bounding box, the share that felt it. */
function shareAmong(members: LatLon[], listeners: Listener[], felt: Set<string>) {
  const lat = members.map((m) => m.lat);
  const lon = members.map((m) => m.lon);
  const [s, n, w, e] = [Math.min(...lat), Math.max(...lat), Math.min(...lon), Math.max(...lon)];
  let inside = 0;
  let yes = 0;
  for (const l of listeners) {
    if (l.lat < s || l.lat > n || l.lon < w || l.lon > e) continue;
    inside++;
    if (felt.has(l.id)) yes++;
  }
  return inside ? yes / inside : 1;
}

/**
 * Provisional detection from raw picks, seconds after the P wave, before any phone has
 * finished vetting its own shaking. Footsteps and slams also produce picks, so a cluster is
 * only declared once the phones that stayed quiet agree too (see `verdict`). `waiting` says a
 * candidate needs another look shortly, once the phones the wave is still reaching have spoken.
 */
export function earlyDetect(picks: Trigger[], listeners: Listener[], now: number, o: EarlyOptions = {}): { events: EarlyEvent[]; waiting: boolean } {
  const minPicks = o.minPicks ?? 4;
  const maxRms = o.maxRmsS ?? 1;
  const slack = o.slackS ?? 1.5;
  const recent = picks.filter((p) => now - p.t <= (o.windowMs ?? 60_000) && p.t <= now);
  const picked = new Set(recent.map((p) => p.node));
  const events: EarlyEvent[] = [];
  let waiting = false;

  const rejected: Verdict = { agreement: 0, ok: false, waiting: false };
  for (const cand of associate(recent, { minNodes: minPicks, maxRmsS: 2 })) {
    let ev = cand;
    let v = cand.rms <= maxRms ? verdict(cand, cand.time, cand.triggers, listeners, picked, now, o) : rejected;
    // Arrival times alone can put a quake seen from one side where quiet phones object. When
    // enough places felt it to be sure it is real, and most phones among them did, look for
    // an epicentre that explains the picks and the silence together.
    if (!v.ok && !v.waiting && cand.rms <= maxRms && new Set(cand.triggers.map(cellOf)).size >= 2 * minPicks && shareAmong(cand.triggers, listeners, picked) >= 0.2) {
      const ref = cand.triggers[0].t;
      const silent = listeners.filter((n) => !picked.has(n.id));
      const sol = locate(
        cand.triggers.map((t) => ({ lat: t.lat, lon: t.lon, t: (t.t - ref) / 1000, phase: t.phase })),
        { minArrivals: minPicks, silent, now: (now - ref) / 1000, silentSlackS: slack },
      );
      if (sol && sol.rms <= maxRms) {
        const members = sol.used.map((i) => cand.triggers[i]);
        ev = { ...sol, id: cand.id, time: ref + sol.t0 * 1000, triggers: members };
        v = verdict(ev, ev.time, members, listeners, picked, now, o);
      }
    }
    if (v.ok && ev.triggers.length >= minPicks) events.push({ ...ev, agreement: v.agreement });
    else waiting ||= v.waiting;
  }
  return { events, waiting };
}

/**
 * Confirmed events face the quiet phones too: a few vetted triggers fit one wavefront by chance
 * far more often than every phone around them stays quiet by chance. `felt` holds the phones
 * that picked or triggered around the event's time, retracted or not.
 */
export function corroborated(ev: DetectedEvent, listeners: Listener[], felt: Set<string>, now: number, o: JudgeOptions = {}): boolean {
  return verdict(ev, ev.time, ev.triggers, listeners, felt, now, o).ok;
}
