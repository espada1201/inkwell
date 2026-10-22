import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { LiveNetwork, MAX_NODES } from '../../src/app/live';
import { distanceKm, offset } from '../../src/core/geo';
import { VP_KMS, hypocentralKm, pgaFor } from '../../src/core/physics';
import { signFelt, signHeartbeat, signPick, signRetraction, signTrigger, type Message } from '../../src/net/protocol';
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

  it('a provisional detection whose phones withdrew is closed as not confirmed, with their reasons', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const four = phones.slice(0, 4);
    for (const p of four) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    const picks = four.map((p) => signPick(p.sk, p));
    picks.forEach((ev) => live.ingest(ev));
    live.recompute();
    expect(live.provisional.map((d) => d.outcome)).toEqual(['open']);
    four.forEach((p, i) => live.ingest(signRetraction(p.sk, picks[i].id, i < 3 ? 'footsteps' : 'impulse')));
    live.recompute();
    const [d] = live.provisional;
    expect(d.outcome).toBe('withdrawn');
    expect(d.picks).toHaveLength(4);
    expect(d.withdrew.map((w) => w.reason).sort()).toEqual(['footsteps', 'footsteps', 'footsteps', 'impulse']);
  });

  it('a provisional detection is closed as confirmed by the event its phones confirm, or as unconfirmed after two minutes', () => {
    const confirmed = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const unconfirmed = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const now = Date.now();
    for (const live of [confirmed, unconfirmed]) for (const p of phones) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    const picks = phones.map((p) => signPick(p.sk, p));
    for (const live of [confirmed, unconfirmed]) {
      picks.forEach((ev) => live.ingest(ev));
      live.recompute(now);
    }
    phones.forEach((p, i) => confirmed.ingest(signTrigger(p.sk, { ...p, dur: 5 }, picks[i].id)));
    confirmed.recompute(now);
    expect(confirmed.provisional.map((d) => d.outcome)).toEqual(['confirmed']);
    expect(confirmed.provisional[0].confirmed).toBe(confirmed.events[0]);
    // Its picks age out after a minute, but the phones may still confirm: it waits two.
    unconfirmed.recompute(now + 70_000);
    expect(unconfirmed.provisional.map((d) => d.outcome)).toEqual(['open']);
    unconfirmed.recompute(now + 121_000);
    expect(unconfirmed.provisional.map((d) => d.outcome)).toEqual(['unconfirmed']);
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

  it('says how each phone is drawn: checking a pick, confirmed shaking, idle or offline', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const [a, b, c, d] = phones;
    for (const p of [a, b, c]) live.ingest(signHeartbeat(p.sk, { ...p, noise: 0.01, sps: 60 }));
    live.ingest(signHeartbeat(d.sk, { ...d, noise: 0.01, sps: 0 }));
    live.ingest(signPick(a.sk, a));
    live.ingest(signTrigger(b.sk, { ...b, dur: 3 }));
    const withdrawn = signPick(c.sk, c);
    live.ingest(withdrawn);
    live.ingest(signRetraction(c.sk, withdrawn.id, 'footsteps'));
    const states = Object.fromEntries(live.nodeStates().map((n) => [n.id, n.state]));
    const key = (p: (typeof phones)[number]) => getPublicKey(p.sk);
    expect(states).toEqual({ [key(a)]: 'pick', [key(b)]: 'trigger', [key(c)]: 'idle', [key(d)]: 'offline' });
  });

  it('reports the USGS feed as unavailable when it fails', async () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    await live.refreshUsgs();
    expect(live.usgsState).toBe('error');
  });

  it('takes felt reports from anyone, one per key per ten minutes, and shows a shaking once three keys in three places agree', () => {
    const live = new LiveNetwork(new NullTransport(), 'hour', fetchNone);
    const now = Date.now();
    const [a, b, c] = phones;
    // No heartbeats: feeling shaking takes no sensor.
    live.ingest(signFelt(a.sk, { ...a, t: now - 15 * 60_000, lvl: 2 }));
    live.ingest(signFelt(a.sk, { ...a, t: now - 8 * 60_000, lvl: 5 }));
    live.ingest(signFelt(a.sk, { ...a, t: now - 2 * 60_000, lvl: 2 }));
    expect(live.felt.map((f) => f.t)).toEqual([now - 15 * 60_000, now - 2 * 60_000]);
    live.recompute();
    expect(live.feltClusters).toEqual([]);
    live.ingest(signFelt(b.sk, { ...b, t: now - 60_000, lvl: 3 }));
    live.ingest(signFelt(c.sk, { ...c, t: now, lvl: 4 }));
    live.recompute();
    expect(live.feltClusters).toEqual([expect.objectContaining({ people: 3, places: 3, lvl: 3, time: now - 2 * 60_000 })]);
  });

  it('sends a felt report only when this key has sent none in the last ten minutes', () => {
    const sent: Event[] = [];
    const live = new LiveNetwork(Object.assign(new NullTransport(), { publish: (ev: Event) => void sent.push(ev) }), 'hour', fetchNone);
    const sk = generateSecretKey();
    const me = { sk, pubkey: getPublicKey(sk) };
    expect(live.reportFelt(me, src, 3)).toBe(true);
    expect(live.reportFelt(me, src, 5)).toBe(false);
    expect(sent.map((ev) => JSON.parse(ev.content).lvl)).toEqual([3]);
    expect(live.lastFelt(me.pubkey, Date.now())).toMatchObject({ lvl: 3, lat: 37.9, lon: -122.3 });
  });
});
