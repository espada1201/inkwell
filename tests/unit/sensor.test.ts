import { generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reachKm, SensorNode } from '../../src/app/sensor';
import { offset } from '../../src/core/geo';
import { hypocentralKm, pgaFor, VP_KMS } from '../../src/core/physics';
import { NodeDetector, type DetectorOutput } from '../../src/core/sensor';
import { synthesize, type SynthOptions } from '../../src/core/synth';
import { parse, signOutput, type Message } from '../../src/net/protocol';

function run(o: Omit<SynthOptions, 'start' | 'durationS' | 'seed'> & { seed?: number; durationS?: number; start?: number }) {
  const det = new NodeDetector(50);
  const out: DetectorOutput[] = [];
  for (const s of synthesize({ start: 0, durationS: 90, seed: 7, ...o })) {
    const r = det.push(s);
    if (r) out.push(r);
  }
  return { out, triggers: out.filter((r) => r.kind === 'trigger'), det };
}

describe('per-phone trigger', () => {
  it('stays silent on a quiet table', () => {
    for (const seed of [1, 2, 3]) expect(run({ seed }).out).toEqual([]);
  });

  it('triggers on an earthquake with onset near the P arrival', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { triggers } = run({ seed, quake: { tP: 30, tS: 34, pga: 0.6 } });
      expect(triggers).toHaveLength(1);
      expect(triggers[0].t / 1000).toBeGreaterThan(29.9);
      expect(triggers[0].t / 1000).toBeLessThan(30.6);
      expect(triggers[0].pga).toBeGreaterThan(0.3);
    }
  });

  it('triggers on S when P is too weak, still once', () => {
    const { triggers } = run({ quake: { tP: 30, tS: 31.5, pga: 0.25 } });
    expect(triggers).toHaveLength(1);
  });

  it('rejects footsteps', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { out, triggers } = run({ seed, footsteps: { t: 30, count: 10 } });
      expect(triggers).toHaveLength(0);
      expect(out.some((o) => o.kind === 'reject' && o.reason === 'footsteps')).toBe(true);
    }
  });

  it('rejects a door slam as an impulse', () => {
    for (const seed of [1, 2, 3]) {
      const { out, triggers } = run({ seed, slam: { t: 30 } });
      expect(triggers).toHaveLength(0);
      expect(out.some((o) => o.kind === 'reject' && o.reason === 'impulse')).toBe(true);
    }
  });

  it('rejects being picked up', () => {
    const { out, triggers } = run({ pickup: { t: 30 } });
    expect(triggers).toHaveLength(0);
    expect(out.some((o) => o.kind === 'reject' && o.reason === 'handling')).toBe(true);
  });

  it('raises its threshold after false alarms', () => {
    const { det } = run({ slam: { t: 30 }, durationS: 50 });
    expect(det.threshold).toBeGreaterThan(det.base);
  });

  it('ignores weak shaking under the noise floor', () => {
    expect(run({ quake: { tP: 30, tS: 34, pga: 0.03 } }).triggers).toHaveLength(0);
  });

  it('knows the background noise as soon as it has warmed up', () => {
    for (const noise of [0.008, 0.012, 0.018])
      for (const seed of [1, 2, 3]) {
        const det = new NodeDetector(50);
        let warm = 0;
        for (const s of synthesize({ start: 0, durationS: 120, seed, noise })) {
          det.push(s);
          if (!warm && !det.warmingUp) warm = det.background;
        }
        expect(warm / det.background).toBeGreaterThan(0.85);
        expect(warm / det.background).toBeLessThan(1.15);
      }
  });

  it('learns the background afresh after a break, wherever the phone lies', () => {
    // Turned on its side while listening, hidden for ten seconds, then laid flat again.
    for (const seed of [1, 2, 3]) {
      const det = new NodeDetector(50);
      let warm = 0;
      for (const s of synthesize({ start: 0, durationS: 150, seed, noise: 0.012 })) {
        if (s.t > 30_000 && s.t < 40_000) continue;
        det.push(s.t > 15_000 && s.t < 30_000 ? { t: s.t, x: s.x, y: s.z, z: s.y } : s);
        if (s.t > 40_000 && !warm && !det.warmingUp) warm = det.background;
      }
      expect(warm / det.background).toBeGreaterThan(0.85);
      expect(warm / det.background).toBeLessThan(1.15);
    }
  });
});

describe('disturbances that only just cross the trigger', () => {
  // Their peak is a few times the background, so shares of the peak alone fall inside the noise.
  it('never confirms knocks or footstep trains of 0.3–0.8 m/s²', () => {
    for (const count of [1, 3, 10])
      for (const amp of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
        for (const noise of [0.008, 0.01, 0.012, 0.014, 0.016, 0.018])
          for (const seed of [1, 2, 3, 4])
            expect(run({ seed, noise, durationS: 60, footsteps: { t: 20, count, amp } }).triggers, `${count} × ${amp} m/s², noise ${noise}, seed ${seed}`).toEqual([]);
  });

  it('still confirms light quake shaking, short or long', () => {
    // The odd one comes in short bursts and is taken for footsteps, as it was before this rule.
    let confirmed = 0;
    for (const decayS of [2, 3, 4, 5])
      for (const sp of [1, 5, 9])
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
          confirmed += +(run({ seed, noise: 0.01 + 0.002 * ((seed - 1) % 4), quake: { tP: 30, tS: 30 + sp, pga: 0.15, decayS } }).triggers.length === 1);
    expect(confirmed).toBeGreaterThanOrEqual(95);
  });
});

describe('strong and distant quakes', () => {
  it('captures the late S-wave peak of a strong quake', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { triggers } = run({ seed, quake: { tP: 30, tS: 38, pga: 2, decayS: 8 } });
      expect(triggers).toHaveLength(1);
      expect(triggers[0].t / 1000).toBeLessThan(30.6);
      expect(triggers[0].pga).toBeGreaterThan(1.2);
    }
  });

  it('triggers on S alone when P is below the noise floor', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { triggers } = run({ seed, quake: { tP: 30, tS: 42, pga: 0.15, decayS: 6 } });
      expect(triggers).toHaveLength(1);
      expect(triggers[0].t / 1000).toBeGreaterThan(41.9);
    }
  });
});

describe('provisional picks', () => {
  it('sends a pick at the onset, long before the confirmed trigger', () => {
    const { out } = run({ quake: { tP: 30, tS: 34, pga: 0.6 } });
    const pick = out.find((o) => o.kind === 'pick')!;
    const trig = out.find((o) => o.kind === 'trigger')!;
    expect(pick.t).toBe(trig.t);
    // Sent 0.4 s after the onset it marks: long enough to tell P from S.
    expect(pick.at - pick.t).toBeLessThanOrEqual(500);
    expect(trig.at - pick.t).toBeGreaterThanOrEqual(15_000);
  });

  it('gives its verdict 15 to 30 s after the onset, never later', () => {
    // Phone clocks do not tick on whole sample times; long shaking runs into the 30 s limit.
    for (const start of [0, -86.3, 4567.89])
      for (const o of [{ quake: { tP: 30, tS: 38, pga: 2, decayS: 15 } }, { footsteps: { t: 30, count: 60 } }, { slam: { t: 30 } }])
        for (const seed of [1, 2, 3])
          for (const f of run({ seed, start, ...o }).out.filter((x) => x.kind !== 'pick')) {
            expect(f.at - f.t).toBeGreaterThanOrEqual(15_000);
            expect(Math.round(f.at - f.t)).toBeLessThanOrEqual(30_000);
          }
  });

  it('every pick is later resolved as either a trigger or a reject', () => {
    for (const o of [{ footsteps: { t: 30, count: 10 } }, { slam: { t: 30 } }, { quake: { tP: 30, tS: 34, pga: 0.6 } }]) {
      const { out } = run(o);
      const picks = out.filter((x) => x.kind === 'pick');
      const finals = out.filter((x) => x.kind !== 'pick');
      expect(picks.map((p) => p.t)).toEqual(finals.map((f) => f.t));
    }
  });

  it('withdraws its pick when the samples stop before it could check the shaking', () => {
    const det = new NodeDetector(50);
    const out: DetectorOutput[] = [];
    for (const s of synthesize({ start: 0, durationS: 90, seed: 7, quake: { tP: 30, tS: 34, pga: 0.6 } })) {
      // The tab is hidden two seconds after the onset, for ten seconds.
      if (s.t > 32_000 && s.t < 42_000) continue;
      const r = det.push(s);
      if (r) out.push(r);
    }
    const pick = out.find((o) => o.kind === 'pick')!;
    expect(out.filter((o) => o.kind !== 'pick')).toEqual([{ kind: 'reject', t: pick.t, at: 42_000, reason: 'interrupted' }]);
  });

  it('takes its clock being set back as a break in the samples too', () => {
    const det = new NodeDetector(50);
    const out: DetectorOutput[] = [];
    for (const s of synthesize({ start: 0, durationS: 90, seed: 7, quake: { tP: 30, tS: 34, pga: 0.6 } })) {
      // Two seconds after the onset, the phone's clock is set back a minute.
      const r = det.push(s.t > 32_000 ? { ...s, t: s.t - 60_000 } : s);
      if (r) out.push(r);
    }
    const pick = out.find((o) => o.kind === 'pick')!;
    expect(out.find((o) => o.kind !== 'pick')).toMatchObject({ kind: 'reject', t: pick.t, reason: 'interrupted' });
  });

  it('starts afresh after a break or its clock being set back, then hears the next quake', () => {
    // A door slam at 20 s raises the threshold and holds off the next onset for a moment. At 60 s
    // the samples stop for ten seconds, or the clock is set back two minutes, ten minutes or a
    // day, with nothing being checked or with footsteps being checked; a quake comes 40 s later.
    for (const jump of [10_000, -120_000, -600_000, -86_400_000])
      for (const footsteps of [undefined, { t: 58, count: 4 }]) {
        const det = new NodeDetector(50);
        const out: DetectorOutput[] = [];
        for (const s of synthesize({ start: 0, durationS: 150, seed: 7, slam: { t: 20 }, footsteps, quake: { tP: 100, tS: 104, pga: 0.6 } })) {
          const r = det.push(s.t > 60_000 ? { ...s, t: s.t + jump } : s);
          if (r) out.push(r);
        }
        const what = `clock ${jump / 1000} s, ${footsteps ? 'footsteps' : 'nothing'} being checked`;
        expect(out.map((o) => (o.kind === 'reject' ? o.reason : o.kind)), what).toEqual(['pick', 'impulse', ...(footsteps ? ['pick', 'interrupted'] : []), 'pick', 'trigger']);
        expect(det.threshold, what).toBe(det.base);
      }
  });

  it('never raises its threshold when its clock steps back by less than a second', () => {
    // The slam's false alarm raises the threshold, which then only relaxes; at 60 s the clock is set back 0.9 s.
    const det = new NodeDetector(50);
    let was = Infinity;
    for (const s of synthesize({ start: 0, durationS: 70, seed: 7, slam: { t: 20 } })) {
      det.push(s.t > 60_000 ? { ...s, t: s.t - 900 } : s);
      if (s.t > 40_000) expect(det.threshold).toBeLessThanOrEqual(was);
      was = det.threshold;
    }
  });
});

describe('telling P from S by which way the phone shakes', () => {
  it('labels a strong, close quake by its P wave', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { out } = run({ seed, quake: { tP: 30, tS: 34, pga: 0.6 } });
      expect(out.find((o) => o.kind === 'pick')!.phase).toBe('P');
      expect(out.find((o) => o.kind === 'trigger')!.phase).toBe('P');
    }
  });

  it('labels a quake whose P wave was too weak to notice by its S wave', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { out } = run({ seed, quake: { tP: 30, tS: 42, pga: 0.15, decayS: 6 } });
      expect(out.find((o) => o.kind === 'pick')!.phase).toBe('S');
      expect(out.find((o) => o.kind === 'trigger')!.phase).toBe('S');
    }
  });

  it('knows which way is down however the phone lies', () => {
    // Same quake, phone propped on its side: gravity now along y, not z.
    const det = new NodeDetector(50);
    const out: DetectorOutput[] = [];
    for (const s of synthesize({ start: 0, durationS: 90, seed: 3, quake: { tP: 30, tS: 34, pga: 0.6 } })) {
      const r = det.push({ t: s.t, x: s.x, y: s.z, z: s.y });
      if (r) out.push(r);
    }
    expect(out.find((o) => o.kind === 'trigger')!.phase).toBe('P');
  });
});

describe('this phone on the network', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Just enough of a browser around SensorNode: motion events, page visibility, a screen wake lock. */
  function phone() {
    const sent: Message[] = [];
    const on: Record<string, (e?: unknown) => void> = {};
    const target = { addEventListener: (k: string, f: (e?: unknown) => void) => void (on[k] = f), removeEventListener: (k: string) => void delete on[k] };
    const doc = { ...target, visibilityState: 'visible' };
    const locks = new Set<object>();
    vi.stubGlobal('DeviceMotionEvent', class {});
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', {
      wakeLock: {
        request: async () => {
          const lock = { release: async () => void locks.delete(lock) };
          locks.add(lock);
          return lock;
        },
      },
    });
    const node = new SensorNode({ publish: (ev) => sent.push(parse(ev)!), subscribe: () => () => {}, statuses: () => [], onStatus: () => {}, close: () => {} });
    node.setLocation({ lat: 37.77, lon: -122.42 });
    node.setJoined(true);
    /** The phone lies on a table for real time: each sample moves the clocks on by 20 ms. */
    const feed = (o: Omit<SynthOptions, 'start' | 'seed'>) => {
      for (const s of synthesize({ start: 0, seed: 1, ...o })) {
        vi.advanceTimersByTime(20);
        on.devicemotion?.({ accelerationIncludingGravity: s, interval: 20, timeStamp: performance.now() });
      }
    };
    const heartbeats = () => sent.filter((m) => m.type === 'heartbeat');
    return { node, sent, on, doc, locks, feed, heartbeats };
  }
  /** Let promises already resolved, such as a granted wake lock, run their callbacks. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('announces itself once warmed up, with the background it learned, listening since then', async () => {
    const { node, feed, heartbeats } = phone();
    const t0 = Date.now();
    await node.start();
    feed({ durationS: 4 });
    expect(heartbeats()).toEqual([]);
    feed({ durationS: 16 });
    expect(heartbeats()).toHaveLength(1);
    const hb = heartbeats()[0].data;
    expect(hb.sps).toBe(50);
    // Ten samples to learn the rate, then five seconds of warm-up.
    expect(hb.since! - t0).toBeGreaterThan(5000);
    expect(hb.since! - t0).toBeLessThan(5500);
    expect(hb.noise / node.detector!.background).toBeGreaterThan(0.85);
    expect(hb.noise / node.detector!.background).toBeLessThan(1.15);
  });

  it('after a break, announces itself again only once it has warmed up again', async () => {
    const { node, feed, heartbeats } = phone();
    await node.start();
    feed({ durationS: 10 });
    // No samples for ten seconds, as in a hidden tab.
    vi.advanceTimersByTime(10_000);
    const back = Date.now();
    feed({ durationS: 4 });
    expect(heartbeats()).toHaveLength(1);
    feed({ durationS: 4 });
    expect(heartbeats()).toHaveLength(2);
    expect(heartbeats()[1].data.since! - back).toBeGreaterThanOrEqual(5000);
  });

  it('holds one wake lock and one heartbeat timer however often Start is tapped, and Stop lets go', async () => {
    const { node, feed, locks, heartbeats } = phone();
    await Promise.all([node.start(), node.start()]);
    await settle();
    expect(locks.size).toBe(1);
    // Two minutes of listening: a heartbeat once warmed up, then one a minute.
    feed({ durationS: 126 });
    expect(heartbeats()).toHaveLength(3);
    node.stop();
    await settle();
    expect(locks.size).toBe(0);
    // Stopped before the screen lock was even granted.
    await node.start();
    node.stop();
    await settle();
    expect(locks.size).toBe(0);
  });

  it('starts over when Start is tapped again after no motion data came', async () => {
    const { node, feed, locks, heartbeats } = phone();
    await node.start();
    vi.advanceTimersByTime(5000);
    expect(node.state).toBe('no-data');
    await node.start();
    await settle();
    expect(node.state).toBe('warming');
    expect(locks.size).toBe(1);
    feed({ durationS: 126 });
    expect(heartbeats()).toHaveLength(3);
  });

  it('withdraws a pick still being checked when stopped, and says so in its log', async () => {
    const { node, feed, sent } = phone();
    await node.start();
    feed({ durationS: 40, quake: { tP: 30, tS: 33, pga: 0.6 } });
    const pick = sent.find((m) => m.type === 'pick')!;
    node.stop();
    expect(sent.filter((m) => m.type === 'retract')).toEqual([expect.objectContaining({ pick: pick.id })]);
    expect(node.log).toEqual([expect.objectContaining({ out: expect.objectContaining({ kind: 'reject', t: pick.data.t, reason: 'interrupted' }), published: true })]);
  });

  it('tells the network it has stopped before it stops sharing', async () => {
    const { node, feed, heartbeats } = phone();
    await node.start();
    feed({ durationS: 6 });
    node.setJoined(false);
    expect(heartbeats().map((m) => m.data.sps)).toEqual([50, 0]);
  });

  it('withdraws a pick still being checked when it stops sharing, and goes on checking it for its log', async () => {
    const { node, feed, sent } = phone();
    await node.start();
    feed({ durationS: 40, quake: { tP: 30, tS: 33, pga: 0.6 } });
    const pick = sent.find((m) => m.type === 'pick')!;
    node.setJoined(false);
    expect(sent.filter((m) => m.type === 'retract')).toEqual([expect.objectContaining({ pick: pick.id, reason: 'interrupted' })]);
    // Its verdict comes as before, for this phone only.
    const before = sent.length;
    feed({ durationS: 30 });
    expect(sent).toHaveLength(before);
    expect(node.log).toEqual([expect.objectContaining({ out: expect.objectContaining({ kind: 'trigger', t: pick.data.t }), published: false })]);
  });

  it('withdraws a pick still being checked as soon as the tab is hidden', async () => {
    const { node, feed, sent, doc, on, heartbeats } = phone();
    await node.start();
    feed({ durationS: 40, quake: { tP: 30, tS: 33, pga: 0.6 } });
    doc.visibilityState = 'hidden';
    on.visibilitychange();
    expect(sent.filter((m) => m.type === 'retract')).toHaveLength(1);
    expect(heartbeats().at(-1)!.data.sps).toBe(0);
    // Back after ten seconds: nothing is withdrawn twice.
    vi.advanceTimersByTime(10_000);
    doc.visibilityState = 'visible';
    on.visibilitychange();
    feed({ durationS: 10 });
    expect(sent.filter((m) => m.type === 'retract')).toHaveLength(1);
    expect(node.log).toHaveLength(1);
  });

  it('dates what it sends by the wall clock, even when the event clock has fallen behind', async () => {
    const { node, feed, sent, heartbeats } = phone();
    await node.start();
    feed({ durationS: 10 });
    // Asleep for an hour: the wall clock moved on, the clock motion events are stamped by did not.
    vi.setSystemTime(Date.now() + 3600_000);
    feed({ durationS: 40, quake: { tP: 30, tS: 33, pga: 0.6 } });
    const pick = sent.find((m) => m.type === 'pick')!;
    expect(Math.abs(pick.data.t - (Date.now() - 10_000))).toBeLessThan(1000);
    expect(heartbeats().at(-1)!.data.since).toBeGreaterThan(Date.now() - 40_000);
  });

  it('counts the time it listened, this session and this week, in this browser only', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    const { node, feed } = phone();
    await node.start();
    feed({ durationS: 65 });
    node.stop();
    // Ten samples to learn the rate, five seconds of warm-up, then a minute of listening.
    const { session, week } = node.listened();
    expect(session).toBeGreaterThan(59_000);
    expect(session).toBeLessThan(60_000);
    expect(week).toBe(session);
    const next = phone().node;
    expect(next.listened()).toEqual({ session: 0, week });
    // A new week starts from nothing.
    vi.setSystemTime(Date.now() + 7 * 86400_000);
    expect(next.listened().week).toBe(0);
  });

  it('tells which quakes nearby it felt, missed, or found too weak, as the shaking model expects', async () => {
    const { node, feed } = phone();
    await node.start();
    const t0 = Date.now();
    feed({ durationS: 110, quake: { tP: 30, tS: 33, pga: 0.6 } });
    /** A USGS quake 10 km down, whose P wave reaches this phone `arrivalS` into the record. */
    const usgs = (id: string, mag: number, km: number, arrivalS: number) => ({
      id, mag, place: id, depthKm: 10, url: '', ...offset(node.location!, km, 0),
      time: t0 + arrivalS * 1000 - (hypocentralKm(km, 10) / VP_KMS) * 1000,
    });
    const quakes = [
      usgs('the one it felt', 5, 20, 30),
      usgs('as strong, but it heard nothing', 5, 20, 45),
      usgs('too weak to notice here', 3, 40, 60),
      usgs('too weak to reach its floor', 2, 40, 60),
      usgs('before it listened', 5, 20, 2),
    ];
    expect(node.nearbyQuakes(quakes).map((q) => [q.quake.id, q.verdict])).toEqual([
      ['the one it felt', 'felt'],
      ['as strong, but it heard nothing', 'missed'],
      ['too weak to notice here', 'too weak'],
    ]);
  });

  it('inverts the shaking model into how far away a quake would still be noticed', () => {
    for (const [mag, pga] of [[4, 0.1], [5, 0.1], [5, 0.5]]) expect(pgaFor(mag, hypocentralKm(reachKm(mag, pga)))).toBeCloseTo(pga, 4);
    expect(reachKm(4, 5)).toBe(0);
  });

  it('signs what a phone publishes for each output: the pick, then its retraction or a trigger linked to it', () => {
    const sk = generateSecretKey();
    const here = { lat: 37.77, lon: -122.42 };
    const t = Date.now() - 30_000;
    const pick = signOutput(sk, here, { kind: 'pick', t, at: t + 400, phase: 'S' })!;
    expect(parse(pick)).toMatchObject({ type: 'pick', data: { ...here, t, phase: 'S' } });
    const trigger = signOutput(sk, here, { kind: 'trigger', t, at: t + 20_000, phase: 'S', pga: 0.3, durS: 4 }, pick.id)!;
    expect(parse(trigger)).toMatchObject({ type: 'trigger', pick: pick.id, data: { ...here, t, phase: 'S', pga: 0.3, dur: 4 } });
    // A retraction is dated when the phone gave up on its pick; with no pick open there is nothing to withdraw.
    const gaveUp = { kind: 'reject', t, at: t + 20_000, reason: 'footsteps' } as const;
    expect(parse(signOutput(sk, here, gaveUp, pick.id)!)).toMatchObject({ type: 'retract', pick: pick.id, at: Math.floor((t + 20_000) / 1000) * 1000 });
    expect(signOutput(sk, here, gaveUp)).toBeNull();
  });
});
