import { generateSecretKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/pure';
import { SCENARIOS, simulate, type Simulation } from '../../src/core/scenarios';
import { signHeartbeat, signPick, signRetraction, signTrigger } from '../../src/net/protocol';

/** Send events to a relay over a plain WebSocket and wait until each is acknowledged. */
export async function send(url: string, events: Event[]) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const pending = new Set(events.map((e) => e.id));
  const done = new Promise<void>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg[0] === 'OK') pending.delete(msg[1]);
      if (!pending.size) res();
    };
  });
  for (const e of events) ws.send(JSON.stringify(['EVENT', e]));
  if (events.length) await done;
  ws.close();
}

/**
 * Run a bundled scenario through the real phone detector, as if it ended just now, and
 * turn it into the signed events each simulated phone would have published.
 */
export function scenarioEvents(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const sim: Simulation = simulate(s, Date.now() - 80_000);
  const heartbeats: Event[] = [];
  const picks: Event[] = [];
  const finals: Event[] = [];
  for (const n of sim.nodes) {
    const sk = generateSecretKey();
    heartbeats.push(signHeartbeat(sk, { lat: n.lat, lon: n.lon, noise: 0.01, sps: 50 }, Math.floor(sim.start / 1000)));
    let open: Event | null = null;
    for (const o of n.outputs) {
      if (o.kind === 'pick') {
        open = signPick(sk, { lat: n.lat, lon: n.lon, t: o.t, phase: o.phase });
        picks.push(open);
      } else if (o.kind === 'reject') {
        if (open) finals.push(signRetraction(sk, open.id, o.reason, Math.floor(o.at / 1000)));
        open = null;
      } else {
        finals.push(signTrigger(sk, { lat: n.lat, lon: n.lon, t: o.t, phase: o.phase, pga: o.pga, dur: o.durS }, open?.id));
        open = null;
      }
    }
  }
  return { sim, heartbeats, picks, finals };
}
