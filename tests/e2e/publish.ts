import { generateSecretKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/pure';
import { SCENARIOS, simulate, type Simulation } from '../../src/core/scenarios';
import { signHeartbeat, signOutput } from '../../src/net/protocol';

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
    let open: { t: number; id: string } | null = null;
    for (const o of n.outputs) {
      // As a phone does: the pick a verdict settles is the open one with its onset.
      const ev = signOutput(sk, n, o, open?.t === o.t ? open.id : undefined);
      open = o.kind === 'pick' ? { t: o.t, id: ev!.id } : null;
      if (ev) (o.kind === 'pick' ? picks : finals).push(ev);
    }
  }
  return { sim, heartbeats, picks, finals };
}
