import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { LiveNetwork, MAX_NODES } from '../../src/app/live';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { signHeartbeat, signPick, signRetraction, signTrigger, type Message } from '../../src/net/protocol';
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

  it('a pick its author withdrew before it arrived stays withdrawn when a stranger retracts it too', () => {
    const [a, b] = phones;
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    for (const p of [a, b]) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    const pick = signPick(a.sk, a);
    live.ingest(signRetraction(a.sk, pick.id, 'footsteps'));
    live.ingest(signRetraction(b.sk, pick.id, 'handling'));
    live.ingest(pick);
    expect(live.picks.has(pick.id)).toBe(false);
  });

  it('a phone that never says since when counts as listening from when it was first heard', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const p = phones[0];
    const now = Math.floor(Date.now() / 1000);
    for (let k = 10; k >= 0; k--) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 50 }, now - k * 60));
    const n = live.nodes.get(getPublicKey(p.sk))!;
    expect(live.isOnline(n, Date.now() - 5 * 60_000)).toBe(true);
    expect(live.isOnline(n, Date.now() - 11 * 60_000)).toBe(false);
    // After saying it stopped, it listens again only from when it is next heard.
    live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 0 }, now + 1));
    live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 50 }, now + 2));
    expect(live.isOnline(live.nodes.get(getPublicKey(p.sk))!, Date.now())).toBe(false);
  });

  it('keeps a bounded number of phones, dropping the one silent longest', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const at = Date.now() - 60_000;
    // Keys cost nothing, so this is what a flood of fresh ones looks like once verified.
    const beat = (i: number, t: number): Message => ({ id: `hb${i}`, node: `node${i}`, at: t, type: 'heartbeat', data: { lat: 1, lon: 2, noise: 0.01, sps: 50 } });
    for (let i = 0; i < MAX_NODES; i++) live.receive(beat(i, at + (i === 7 ? -30_000 : i)));
    live.receive(beat(MAX_NODES, at + MAX_NODES));
    expect(live.nodes.size).toBe(MAX_NODES);
    expect(live.nodes.has('node7')).toBe(false);
    expect(live.nodes.has(`node${MAX_NODES}`)).toBe(true);
  });

  it('a slow answer for the USGS window no longer shown cannot overwrite the current one', async () => {
    const feed = (id: string) => ({ features: [{ id, properties: { mag: 3, place: id, time: Date.now(), url: '' }, geometry: { coordinates: [1, 2, 3] } }] });
    let answerHour: () => void = () => {};
    const slowHour = (async (url: string) => {
      if (url.includes('all_hour')) await new Promise<void>((r) => (answerHour = r));
      return Response.json(feed(url.includes('all_hour') ? 'hour' : 'day'));
    }) as typeof fetch;
    const live = new LiveNetwork(new NullTransport(), 'hour', slowHour);
    const hour = live.refreshUsgs();
    live.setUsgsWindow('day');
    await expect.poll(() => live.usgs.map((q) => q.id)).toEqual(['day']);
    answerHour();
    await hour;
    expect(live.usgsWindow).toBe('day');
    expect(live.usgs.map((q) => q.id)).toEqual(['day']);
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
