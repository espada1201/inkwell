import { associate, type DetectedEvent, type Trigger } from './associate';
import { distanceKm, type LatLon } from './geo';
import { locate } from './locate';
import { VP_KMS, hypocentralKm } from './physics';

export interface EarlyOptions {
  minPicks?: number;
  maxRmsS?: number;
  /** Fraction of the phones that should already have felt the P wave which actually did. */
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
 * the epicentre than the farthest picking phone must mostly have picked as well
 * (the "not-yet-arrived" idea used by real early-warning systems).
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

  for (const cand of associate(recent, { minNodes: minPicks, maxRmsS: 2 })) {
    const ref = cand.triggers[0].t;
    const sol = locate(
      cand.triggers.map((t) => ({ lat: t.lat, lon: t.lon, t: (t.t - ref) / 1000 })),
      { minArrivals: minPicks, silent, now: (now - ref) / 1000, silentSlackS: slack },
    );
    if (!sol || sol.rms > maxRms) continue;
    const members = sol.used.map((i) => cand.triggers[i]);
    const origin = ref + sol.t0 * 1000;
    const reach = Math.max(...members.map((m) => distanceKm(sol, m)));
    const shouldHave = silent.filter((n) => {
      const d = distanceKm(sol, n);
      return d <= reach && origin + (hypocentralKm(d) / VP_KMS + slack) * 1000 <= now;
    }).length;
    const agreement = members.length / (members.length + shouldHave);
    if (members.length < minPicks || agreement < minAgree) continue;
    out.push({ ...sol, id: cand.id, time: origin, triggers: members, agreement });
  }
  return out;
}
