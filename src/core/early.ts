import { associate, type DetectedEvent, type Trigger } from './associate';
import { distanceKm, type LatLon } from './geo';
import { locate, type Solution } from './locate';
import { VP_KMS, VS_KMS, hypocentralKm, type Phase } from './physics';

export interface EarlyOptions {
  minPicks?: number;
  maxRmsS?: number;
  /**
   * Fraction of the phones that should already have felt the quake which actually did, for a
   * cluster of `minPicks`. It relaxes to a third for clusters four times larger.
   */
  minAgreement?: number;
  /** Picks older than this are ignored, ms. */
  windowMs?: number;
  slackS?: number;
}

export interface EarlyEvent extends DetectedEvent {
  /** Picked phones / phones that should have picked by now. */
  agreement: number;
}

/**
 * Provisional detection from raw picks, seconds after the P wave, before any phone has
 * finished vetting its own shaking. Footsteps and slams also produce picks, so a cluster is
 * only declared when the phones that stayed quiet agree too: every listening phone closer to
 * the epicentre than the farthest phone that picked a wave, once that wave has had time to
 * reach it, must mostly have picked as well (the "not-yet-arrived" idea used by real
 * early-warning systems). The minimum handful of picks could be a coincidence of bumps, so
 * then nearly every quiet phone must agree. Four times as many phones on one wavefront cannot
 * be a coincidence, and a weak wave is only noticed by some phones, so then a third will do.
 */
export function earlyDetect(picks: Trigger[], nodes: (LatLon & { id: string })[], now: number, o: EarlyOptions = {}): EarlyEvent[] {
  const minPicks = o.minPicks ?? 4;
  const maxRms = o.maxRmsS ?? 1;
  const minAgree = o.minAgreement ?? 0.85;
  const slack = o.slackS ?? 1.5;
  const recent = picks.filter((p) => now - p.t <= (o.windowMs ?? 60_000) && p.t <= now);
  const picked = new Set(recent.map((p) => p.node));
  const silent = nodes.filter((n) => !picked.has(n.id));
  const out: EarlyEvent[] = [];

  // An epicentre is accepted if the picks fit it and the quiet phones do not object to it.
  const judge = (cand: DetectedEvent, sol: Solution, members: Trigger[], origin: number): EarlyEvent | null => {
    if (sol.rms > maxRms || members.length < minPicks) return null;
    const reach = (phase: Phase) => Math.max(0, ...members.filter((m) => (m.phase ?? 'P') === phase).map((m) => distanceKm(sol, m)));
    const reachP = reach('P');
    const reachS = reach('S');
    const shouldHave = silent.filter((n) => {
      const d = distanceKm(sol, n);
      const v = d <= reachP ? VP_KMS : d <= reachS ? VS_KMS : 0;
      return v > 0 && origin + (hypocentralKm(d) / v + slack) * 1000 <= now;
    }).length;
    const agreement = members.length / (members.length + shouldHave);
    const needed = minAgree - (minAgree - 1 / 3) * Math.min(1, Math.max(0, (members.length - minPicks) / (3 * minPicks)));
    return agreement >= needed ? { ...sol, id: cand.id, time: origin, triggers: members, agreement } : null;
  };

  for (const cand of associate(recent, { minNodes: minPicks, maxRmsS: 2 })) {
    // First the epicentre the arrival times point to. If quiet phones object to it, look for
    // one that explains the picks and the silence together.
    let ev = judge(cand, cand, cand.triggers, cand.time);
    if (!ev) {
      const ref = cand.triggers[0].t;
      const sol = locate(
        cand.triggers.map((t) => ({ lat: t.lat, lon: t.lon, t: (t.t - ref) / 1000, phase: t.phase })),
        { minArrivals: minPicks, silent, now: (now - ref) / 1000, silentSlackS: slack },
      );
      if (sol) ev = judge(cand, sol, sol.used.map((i) => cand.triggers[i]), ref + sol.t0 * 1000);
    }
    if (ev) out.push(ev);
  }
  return out;
}
