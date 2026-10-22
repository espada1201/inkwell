import { describe, expect, it } from 'vitest';
import { generateSecretKey, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { LiveNetwork } from '../../src/app/live';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { signHeartbeat, signPick, signRetraction, signTrigger } from '../../src/net/protocol';
import type { Transport } from '../../src/net/transport';

class NullTransport implements Transport {
  publish() {}
  subscribe(_f: Filter[], _cb: (ev: Event) => void) {
    return () => {};
  }
  statuses() {
    return [];
  }
  onStatus() {}
  close() {}
}

const src = { lat: 37.9, lon: -122.3 };
const T0 = Date.now() - 20_000;
const phones = Array.from({ length: 8 }, (_, i) => {
  const p = offset(src, Math.cos(i) * (10 + 4 * i), Math.sin(i) * (10 + 4 * i));
  const hyp = hypocentralKm(distanceKm(src, p));
  return { sk: generateSecretKey(), ...p, t: T0 + (hyp / VP_KMS) * 1000, pga: pgaFor(5.5, hyp) };
});
const fetchNone = (async () => new Response('{}', { status: 503 })) as typeof fetch;

describe('live network model', () => {
  it('ignores picks from nodes that never sent a heartbeat, then accepts them once one arrives', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const p = phones[0];
    live.ingest(signPick(p.sk, p));
    expect(live.picks.size).toBe(0);
    live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    expect(live.picks.size).toBe(1);
  });

  it('declares a provisional quake from picks alone, then a confirmed one from triggers', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    for (const p of phones) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    const pickIds = phones.map((p) => {
      const ev = signPick(p.sk, p);
      live.ingest(ev);
      return ev.id;
    });
    live.recompute();
    expect(live.early).toHaveLength(1);
    expect(distanceKm(live.early[0], src)).toBeLessThan(10);
    phones.forEach((p, i) => live.ingest(signTrigger(p.sk, { ...p, dur: 5 }, pickIds[i])));
    live.recompute();
    expect(live.events).toHaveLength(1);
    expect(live.early).toHaveLength(0);
    expect(distanceKm(live.events[0], src)).toBeLessThan(5);
  });

  it('retractions remove picks, but only from their own author', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const [a, b] = phones;
    for (const p of [a, b]) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    const pick = signPick(a.sk, a);
    live.ingest(pick);
    live.ingest(signRetraction(b.sk, pick.id, 'footsteps'));
    expect(live.picks.has(pick.id)).toBe(true);
    live.ingest(signRetraction(a.sk, pick.id, 'footsteps'));
    expect(live.picks.has(pick.id)).toBe(false);
  });

  it('a retraction that arrives before its pick counts only from the pick\'s author', () => {
    const [a, b] = phones;
    for (const author of [b, a]) {
      const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
      for (const p of [a, b]) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
      const pick = signPick(a.sk, a);
      live.ingest(signRetraction(author.sk, pick.id, 'footsteps'));
      live.ingest(pick);
      expect(live.picks.has(pick.id)).toBe(author === b);
    }
  });

  it('a few triggers that line up by chance are no quake when the phones around them heard nothing', () => {
    // A grid of phones 2 km apart; five near the middle trigger as if on one wavefront.
    const city = Array.from({ length: 100 }, (_, i) => ({ sk: generateSecretKey(), ...offset(src, 2 * ((i % 10) - 4.5), 2 * (Math.floor(i / 10) - 4.5)) }));
    const five = [44, 45, 54, 55, 66].map((i) => city[i]);
    const listening = T0 - 600_000;
    const confirmed = (heartbeat: (p: (typeof city)[number]) => Event) => {
      const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
      for (const p of city) live.ingest(five.includes(p) ? signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60, since: listening }) : heartbeat(p));
      for (const p of five) live.ingest(signTrigger(p.sk, { ...p, t: T0 + (hypocentralKm(distanceKm(src, p)) / VP_KMS) * 1000, pga: 0.3, dur: 4 }));
      live.recompute();
      return live.events.length;
    };
    expect(confirmed((p) => signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60, since: listening }))).toBe(0);
    // Phones that were not listening when it struck have no say: they started after, or had stopped.
    expect(confirmed((p) => signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60, since: T0 + 5000 }))).toBe(1);
    expect(confirmed((p) => signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 0, since: listening }, Math.floor((T0 - 60_000) / 1000)))).toBe(1);
  });

  it('reports the USGS feed as unavailable when it fails', async () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    await live.refreshUsgs();
    expect(live.usgsState).toBe('error');
  });
});
