import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { filters, parse, signFelt, signHeartbeat, signPick, signRetraction, signTrigger, type Message } from '../../src/net/protocol';
import { RETRY_CAP_MS, RelayPool, isRelayUrl, reach } from '../../src/net/transport';
import { loadIdentity } from '../../src/net/identity';
// @ts-expect-error plain JS test helper
import { startRelay } from '../fake-relay.mjs';

const sk = generateSecretKey();
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('protocol', () => {
  it('signs a trigger that verifies and round-trips with coarse coordinates', () => {
    const t = Date.now();
    const ev = signTrigger(sk, { lat: 37.774929, lon: -122.419416, t, pga: 0.4321, dur: 3.2 });
    const m = parse(ev)! as Extract<Message, { type: 'trigger' }>;
    expect(m.type).toBe('trigger');
    expect(m.node).toBe(getPublicKey(sk));
    expect(m.data).toMatchObject({ lat: 37.77, lon: -122.42, t, pga: 0.4321 });
    expect(ev.content).not.toContain('37.7749');
  });

  it('rejects tampered, forged and malformed events', () => {
    const ev = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 });
    expect(parse({ ...ev, content: ev.content.replace('0.3', '9.9') })).toBeNull();
    expect(parse({ ...ev, pubkey: getPublicKey(generateSecretKey()) })).toBeNull();
    expect(parse(signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 500, dur: 2 }))).toBeNull();
    expect(parse({ ...signHeartbeat(sk, { lat: 1, lon: 2, noise: 0.01, sps: 60 }), kind: 1 })).toBeNull();
  });

  it('rejects a trigger whose onset disagrees with its signed timestamp', () => {
    const ev = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 }, undefined, Math.floor(Date.now() / 1000) - 3600);
    expect(parse(ev)).toBeNull();
  });

  it('heartbeats say since when the phone has listened, and when it has stopped', () => {
    const since = Date.now() - 600_000;
    const m = parse(signHeartbeat(sk, { lat: -43.53, lon: 172.62, noise: 0.012, sps: 60, since }))! as Extract<Message, { type: 'heartbeat' }>;
    expect(m.type).toBe('heartbeat');
    expect(m.data).toMatchObject({ lat: -43.53, lon: 172.62, sps: 60, since });
    expect(parse(signHeartbeat(sk, { lat: -43.53, lon: 172.62, noise: 0.012, sps: 0, since }))).toMatchObject({ data: { sps: 0, since } });
  });

  it('refuses events dated far ahead, which would never expire', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(parse(signHeartbeat(sk, { lat: 1, lon: 2, noise: 0.01, sps: 60 }, now + 3600))).toBeNull();
    // A phone clock a minute fast is fine.
    expect(parse(signHeartbeat(sk, { lat: 1, lon: 2, noise: 0.01, sps: 60 }, now + 60))).not.toBeNull();
  });

  it('refuses onsets dated more than about a minute ahead of now', () => {
    const now = Date.now();
    expect(parse(signPick(sk, { lat: 1, lon: 2, t: now + 240_000 }, Math.floor((now + 120_000) / 1000)))).toBeNull();
    expect(parse(signTrigger(sk, { lat: 1, lon: 2, t: now + 90_000, pga: 0.3, dur: 2 }))).toBeNull();
    expect(parse(signPick(sk, { lat: 1, lon: 2, t: now + 30_000 }))).not.toBeNull();
  });

  it('picks, retractions and pick-linked triggers round-trip', () => {
    const t = Date.now();
    const pick = signPick(sk, { lat: 10.123, lon: 20.456, t });
    expect(parse(pick)).toMatchObject({ type: 'pick', data: { lat: 10.12, lon: 20.46, t } });
    expect(parse(signRetraction(sk, pick.id, 'footsteps'))).toMatchObject({ type: 'retract', pick: pick.id, reason: 'footsteps' });
    expect(parse(signRetraction(sk, pick.id, 'my cat'))).toMatchObject({ type: 'retract', pick: pick.id, reason: null });
    expect(parse(signTrigger(sk, { lat: 10, lon: 20, t, pga: 1, dur: 3 }, pick.id))).toMatchObject({ type: 'trigger', pick: pick.id });
    expect(parse(signRetraction(sk, 'not-an-id', 'x'))).toBeNull();
  });

  it('felt reports round-trip coarsened, felt up to an hour before they were signed, at one of five levels', () => {
    const now = Date.now();
    const s = Math.floor(now / 1000);
    expect(parse(signFelt(sk, { lat: 37.774929, lon: -122.419416, t: now - 600_000, lvl: 3 }))).toMatchObject({ type: 'felt', data: { lat: 37.77, lon: -122.42, t: now - 600_000, lvl: 3 } });
    expect(parse(signFelt(sk, { lat: 1, lon: 2, t: s * 1000 - 3_599_000, lvl: 1 }, s))).not.toBeNull();
    expect(parse(signFelt(sk, { lat: 1, lon: 2, t: s * 1000 - 3_601_000, lvl: 1 }, s))).toBeNull();
    expect(parse(signFelt(sk, { lat: 1, lon: 2, t: now, lvl: 2 }, s - 30))).not.toBeNull();
    expect(parse(signFelt(sk, { lat: 1, lon: 2, t: now, lvl: 2 }, s - 90))).toBeNull();
    expect(parse(signFelt(sk, { lat: 1, lon: 2, t: now + 120_000, lvl: 2 }, s + 120))).toBeNull();
    for (const lvl of [0, 6, 2.5]) expect(parse(signFelt(sk, { lat: 1, lon: 2, t: now, lvl }))).toBeNull();
    expect(filters(now)[0].kinds).toContain(4580);
  });

  it('picks and triggers say which wave the phone felt; older events count as P', () => {
    const t = Date.now();
    expect(parse(signPick(sk, { lat: 1, lon: 2, t, phase: 'S' }))).toMatchObject({ type: 'pick', data: { phase: 'S' } });
    expect(parse(signTrigger(sk, { lat: 1, lon: 2, t, pga: 0.2, dur: 4, phase: 'S' }))).toMatchObject({ type: 'trigger', data: { phase: 'S' } });
    const old = finalizeEvent({ kind: 4578, created_at: Math.floor(t / 1000), tags: [['t', 'tremor']], content: JSON.stringify({ v: 1, lat: 1, lon: 2, t }) }, sk);
    expect(parse(old)).toMatchObject({ type: 'pick', data: { phase: 'P' } });
    const bad = finalizeEvent({ kind: 4578, created_at: Math.floor(t / 1000), tags: [['t', 'tremor']], content: JSON.stringify({ v: 1, lat: 1, lon: 2, t, ph: 'X' }) }, sk);
    expect(parse(bad)).toBeNull();
  });

  it('identity persists in storage', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadIdentity(s).pubkey).toBe(loadIdentity(s).pubkey);
    expect(loadIdentity(null).pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('relay addresses', () => {
  it('takes secure ones, and plain ones only to a relay on this computer', () => {
    for (const u of ['wss://relay.damus.io', 'wss://nos.lol/', 'ws://localhost:7000', 'ws://127.0.0.1:4321/']) expect(isRelayUrl(u), u).toBe(true);
    // A secure page cannot open a plain socket to another host, and would retry it forever.
    for (const u of ['relay.damus.io', 'ws://relay.example.com', 'ws://localhost.example.com', 'https://nos.lol', 'wss://', 'wss://a b', 42]) expect(isRelayUrl(u), String(u)).toBe(false);
  });
});

describe('relay pool against a local fake relay', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it('delivers events between two pools, once each, and replays history to late joiners', async () => {
    const relay = await startRelay();
    cleanup.push(relay.close);
    const a = new RelayPool([relay.url, relay.url]);
    const b = new RelayPool([relay.url]);
    cleanup.push(() => a.close(), () => b.close());
    const got: string[] = [];
    b.subscribe(filters(Date.now() - 60_000), (ev) => got.push(ev.id));
    await until(() => b.statuses()[0].state === 'open');
    const ev = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 });
    a.publish(ev);
    await until(() => got.length === 1);
    expect(got).toEqual([ev.id]);

    const late = new RelayPool([relay.url]);
    cleanup.push(() => late.close());
    const lateGot: string[] = [];
    late.subscribe(filters(Date.now() - 60_000), (e) => lateGot.push(e.id));
    await until(() => lateGot.length === 1);
  });

  it('drops structurally broken events from a hostile relay, and still delivers the good ones', async () => {
    const good = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 });
    const junk = [{ ...good, tags: [null] }, { ...good, tags: 'tremor' }, { ...good, tags: undefined }, { ...good, kind: '4579' }, { ...good, id: 7 }];
    const relay = await startRelay(0, { verify: false, junk: [...junk, good] });
    cleanup.push(relay.close);
    const p = new RelayPool([relay.url]);
    cleanup.push(() => p.close());
    const got: string[] = [];
    p.subscribe(filters(Date.now() - 60_000), (ev) => got.push(ev.id));
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([good.id]);
  });

  it('a doctored copy sent first cannot shadow the real event', async () => {
    const good = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 });
    const relay = await startRelay(0, { verify: false, junk: [{ ...good, content: good.content.replace('0.3', '0.9') }, good] });
    cleanup.push(relay.close);
    const p = new RelayPool([relay.url]);
    cleanup.push(() => p.close());
    const got: string[] = [];
    p.subscribe(filters(Date.now() - 60_000), (ev) => got.push(ev.content));
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([good.content]);
  });

  it('keeps only the newest heartbeat per node', async () => {
    const relay = await startRelay();
    cleanup.push(relay.close);
    const p = new RelayPool([relay.url]);
    cleanup.push(() => p.close());
    const now = Math.floor(Date.now() / 1000);
    p.publish(signHeartbeat(sk, { lat: 1, lon: 1, noise: 0.01, sps: 50 }, now - 60));
    p.publish(signHeartbeat(sk, { lat: 1, lon: 1, noise: 0.02, sps: 50 }, now));
    await until(() => relay.events().length === 1 && JSON.parse(relay.events()[0].content).noise === 0.02);
  });

  it('a relay that cannot be reached counts as down, not connecting, while it retries', async () => {
    const p = new RelayPool(['ws://127.0.0.1:1']);
    cleanup.push(() => p.close());
    expect(reach(p.statuses())).toBe('connecting');
    await until(() => reach(p.statuses()) === 'down');
    const seen = new Set<string>();
    for (const end = Date.now() + 1500; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) seen.add(reach(p.statuses()));
    expect([...seen]).toEqual(['down']);
    expect(p.statuses()[0].failures).toBeGreaterThan(1);
    expect(reach([])).toBe('down');
  });

  it('reconnects and resubscribes after the relay restarts', async () => {
    const relay = await startRelay();
    const port = Number(new URL(relay.url).port);
    const p = new RelayPool([relay.url]);
    cleanup.push(() => p.close());
    const got: string[] = [];
    p.subscribe(filters(Date.now() - 60_000), (ev) => got.push(ev.id));
    await until(() => p.statuses()[0].state === 'open');
    await relay.close();
    await until(() => p.statuses()[0].state !== 'open');
    const relay2 = await startRelay(port);
    cleanup.push(relay2.close);
    await until(() => p.statuses()[0].state === 'open', 5000);
    const ev = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 });
    p.publish(ev);
    await until(() => got.includes(ev.id));
  });
});

describe('a relay that is down', () => {
  class Refused {
    static OPEN = 1;
    static tries: number[] = [];
    readyState = 3;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      Refused.tries.push(Date.now());
      setTimeout(() => this.onerror?.(), 0);
    }
    close() {}
    send() {}
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Refused.tries = [];
  });

  it('is retried after 1 s, 2 s, 4 s and so on, never less often than every five minutes, so the console does not fill up', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Refused);
    const pool = new RelayPool(['wss://down.example']);
    vi.advanceTimersByTime(3600_000);
    pool.close();
    // Each refusal arrives a millisecond after the attempt.
    const gaps = Refused.tries.slice(1).map((t, i) => Math.round((t - Refused.tries[i]) / 1000) * 1000);
    expect(gaps.slice(0, 9)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
    expect(Math.min(...gaps.slice(9))).toBe(RETRY_CAP_MS);
    expect(Refused.tries.length).toBeLessThanOrEqual(20);
    expect(reach(pool.statuses())).toBe('down');
  });

  it('is tried at once when the network comes back, and then again from a second', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Refused);
    const online: (() => void)[] = [];
    vi.stubGlobal('window', { addEventListener: (_: string, f: () => void) => online.push(f), removeEventListener() {} });
    const pool = new RelayPool(['wss://down.example']);
    vi.advanceTimersByTime(60_000);
    const before = Refused.tries.length;
    online.forEach((f) => f());
    expect(Refused.tries.length).toBe(before + 1);
    vi.advanceTimersByTime(1000);
    expect(Refused.tries.length).toBe(before + 2);
    pool.close();
  });
});
