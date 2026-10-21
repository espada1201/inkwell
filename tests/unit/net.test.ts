import { afterEach, describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { filters, parse, signHeartbeat, signTrigger } from '../../src/net/protocol';
import { RelayPool } from '../../src/net/transport';
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
    const m = parse(ev)!;
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
    const ev = signTrigger(sk, { lat: 1, lon: 2, t: Date.now(), pga: 0.3, dur: 2 }, Math.floor(Date.now() / 1000) - 3600);
    expect(parse(ev)).toBeNull();
  });

  it('heartbeats parse', () => {
    const m = parse(signHeartbeat(sk, { lat: -43.53, lon: 172.62, noise: 0.012, sps: 60 }))!;
    expect(m.type).toBe('heartbeat');
    expect(m.data).toMatchObject({ lat: -43.53, lon: 172.62, sps: 60 });
  });

  it('identity persists in storage', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadIdentity(s).pubkey).toBe(loadIdentity(s).pubkey);
    expect(loadIdentity(null).pubkey).toMatch(/^[0-9a-f]{64}$/);
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
