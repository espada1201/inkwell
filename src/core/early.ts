import { associate, type DetectedEvent, type Trigger } from './associate';
import { cellOf, distanceKm, type LatLon } from './geo';
import { locate } from './locate';
import { VP_KMS, VS_KMS, hypocentralKm, intensityLevel, pgaFor } from './physics';

/** A phone that is listening, wherever it is. */
export interface Listener extends LatLon {
  id: string;
}

/** A phone felt something at time t, whether it later withdrew it or not. */
export interface Onset {
  node: string;
  t: number;
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

/** Picks from this many phones make a candidate quake, and a confirmed one needs as many triggers. */
export const MIN_PICKS = 4;
/** Fewer distinct cells than this is one place, where one truck, door or crowd shakes every phone. */
export const MIN_CELLS = 3;
/**
 * Share of the phones that should already have felt a candidate which actually did, for a
 * cluster of MIN_PICKS cells. It relaxes to a third for clusters four times larger.
 */
const MIN_AGREEMENT = 0.85;
/** Seconds of grace for clocks and relays before a quiet phone counts against an event. */
const SLACK_S = 1.5;
/** A provisional quake's arrival times must fit this well, s rms. */
const MAX_RMS_S = 1;
/** Looser candidates are still worth a look: relocating with the quiet phones can fix them. */
const CANDIDATE_MAX_RMS_S = 2;
/** Picks older than this are ignored. */
const PICK_WINDOW_MS = 60_000;
/** Phones heard from between these times around a confirmed event's origin felt it. */
const FELT_BEFORE_MS = 10_000;
const FELT_AFTER_MS = 180_000;
/** Phones notice light shaking reliably (intensity 2, about 0.14 m/s²) and miss much of what is weaker. */
const NOTICED_LEVEL = 2;

/**
 * The quiet phones' say on a candidate event (the "not-yet-arrived" idea used by real
 * early-warning systems). Every listening phone closer to the epicentre than the farthest member
 * that felt a wave should have felt that wave too, once it has had time to arrive. A handful of
 * members could be a coincidence of bumps, so nearly all of those phones must agree. Four times
 * as many cells on one wavefront cannot be a coincidence, and a weak wave is only noticed by some
 * phones, so then a third will do. Cells rather than phones, because phones in one building
 * share their bumps. Nothing is declared while the phones the wave has yet to reach could still
 * overturn the verdict by staying quiet. When the members' shaking gives a magnitude, a phone it
 * would have shaken less than lightly says nothing by staying quiet.
 */
function verdict(ev: DetectedEvent, listeners: Listener[], felt: Set<string>, now: number): Verdict {
  let reachP = 0;
  let reachS = 0;
  for (const m of ev.triggers) {
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
    const hyp = hypocentralKm(d);
    if (ev.mag !== null && intensityLevel(pgaFor(ev.mag, hyp)) < NOTICED_LEVEL) continue;
    if (ev.time + (hyp / v + SLACK_S) * 1000 <= now) due++;
    else pending++;
  }
  const members = ev.triggers.length;
  const cells = new Set(ev.triggers.map(cellOf)).size;
  const agreement = members / (members + due);
  const needed = MIN_AGREEMENT - (MIN_AGREEMENT - 1 / 3) * Math.min(1, Math.max(0, (cells - MIN_PICKS) / (3 * MIN_PICKS)));
  const passes = cells >= MIN_CELLS && agreement >= needed;
  const holds = members / (members + due + pending) >= needed;
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
export function earlyDetect(picks: Trigger[], listeners: Listener[], now: number): { events: EarlyEvent[]; waiting: boolean } {
  const recent = picks.filter((p) => now - p.t <= PICK_WINDOW_MS && p.t <= now);
  const picked = new Set(recent.map((p) => p.node));
  const events: EarlyEvent[] = [];
  let waiting = false;

  const rejected: Verdict = { agreement: 0, ok: false, waiting: false };
  for (const cand of associate(recent, { minNodes: MIN_PICKS, maxRmsS: CANDIDATE_MAX_RMS_S })) {
    let ev = cand;
    let v = cand.rms <= MAX_RMS_S ? verdict(cand, listeners, picked, now) : rejected;
    // Arrival times alone can put a quake seen from one side where quiet phones object. When
    // enough places felt it to be sure it is real, and most phones among them did, look for
    // an epicentre that explains the picks and the silence together.
    if (!v.ok && !v.waiting && cand.rms <= MAX_RMS_S && new Set(cand.triggers.map(cellOf)).size >= 2 * MIN_PICKS && shareAmong(cand.triggers, listeners, picked) >= 0.2) {
      const ref = cand.triggers[0].t;
      const silent = listeners.filter((n) => !picked.has(n.id));
      const sol = locate(
        cand.triggers.map((t) => ({ lat: t.lat, lon: t.lon, t: (t.t - ref) / 1000, phase: t.phase })),
        { minArrivals: MIN_PICKS, silent, now: (now - ref) / 1000, silentSlackS: SLACK_S },
      );
      if (sol && sol.rms <= MAX_RMS_S) {
        ev = { ...sol, id: cand.id, time: ref + sol.t0 * 1000, triggers: sol.used.map((i) => cand.triggers[i]) };
        v = verdict(ev, listeners, picked, now);
      }
    }
    if (v.ok && ev.triggers.length >= MIN_PICKS) events.push({ ...ev, agreement: v.agreement });
    else waiting ||= v.waiting;
  }
  return { events, waiting };
}

/**
 * Events located from vetted triggers that the phones listening when each struck do not
 * contradict: a few triggers fit one wavefront by chance far more often than every phone around
 * them stays quiet by chance. Every phone heard from around an event's origin felt it, withdrawn
 * or not. An event dated ahead of now is judged by the phones listening now.
 */
export function confirmedEvents(triggers: Trigger[], heard: Onset[], listenersAt: (t: number) => Listener[], now: number): DetectedEvent[] {
  return associate(triggers).filter((e) => {
    const felt = new Set(heard.filter((h) => h.t >= e.time - FELT_BEFORE_MS && h.t <= e.time + FELT_AFTER_MS).map((h) => h.node));
    return verdict(e, listenersAt(Math.min(e.time, now)), felt, now).ok;
  });
}
