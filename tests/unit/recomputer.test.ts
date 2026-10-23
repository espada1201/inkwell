import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EARLY_DELAY_MS, Recomputer, WAITING_RECHECK_MS, type Hooks } from '../../src/app/recomputer';
import type { Compute, ModelOutput } from '../../src/app/model';

const none: ModelOutput = { events: [], early: [], uncertainty: [], waiting: false };

describe('when and where the quake model is worked out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const hooks = () => {
    const applied: number[] = [];
    const emitted = vi.fn();
    const h: Hooks = { source: () => ({ nodes: new Map(), picks: new Map(), triggers: [], heard: [] }), apply: (_o, now) => void applied.push(now), emit: emitted };
    return { h, applied, emitted };
  };

  it('on the page, answers at once, tells the screens, and rests three times what it cost, from 200 ms', () => {
    const { h, applied, emitted } = hooks();
    const r = new Recomputer(h);
    r.run(5);
    expect(applied).toEqual([5]);
    expect(emitted).toHaveBeenCalledTimes(1);
    r.request(false);
    vi.advanceTimersByTime(EARLY_DELAY_MS - 1);
    expect(applied).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(applied).toHaveLength(2);
  });

  it('an early request brings forward a request that was to wait longer, and never puts one off', async () => {
    const { h, applied } = hooks();
    let slow = 900;
    const compute: Compute = () => new Promise((done) => setTimeout(() => done(none), slow));
    const r = new Recomputer(h, compute);
    r.run();
    await vi.advanceTimersByTimeAsync(900);
    // The last run took 900 ms, so a heartbeat waits three times a third of that.
    const before = applied.length;
    r.request(false);
    await vi.advanceTimersByTimeAsync(100);
    r.request(true);
    await vi.advanceTimersByTimeAsync(EARLY_DELAY_MS);
    expect(applied.length).toBe(before);
    slow = 1;
    await vi.advanceTimersByTimeAsync(900);
    expect(applied.length).toBe(before + 1);
    r.request(true);
    r.request(false);
    await vi.advanceTimersByTimeAsync(EARLY_DELAY_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(applied.length).toBe(before + 2);
  });

  it('looks again after 500 ms when a candidate holds, however dear the last run was', async () => {
    const { h, applied } = hooks();
    let waiting = true;
    const compute: Compute = () => new Promise((done) => setTimeout(() => done({ ...none, waiting }), 900));
    const r = new Recomputer(h, compute);
    r.run();
    await vi.advanceTimersByTimeAsync(900);
    expect(applied).toHaveLength(1);
    waiting = false;
    await vi.advanceTimersByTimeAsync(WAITING_RECHECK_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(applied).toHaveLength(2);
  });

  it('moves to the page when the worker rejects, starting it from everything, and does not ask the worker again', async () => {
    const { h, applied } = hooks();
    const asked = vi.fn();
    const r = new Recomputer(h, async (d) => {
      asked(d);
      throw new Error('gone');
    });
    r.run(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([1]);
    r.run(2);
    expect(applied).toEqual([1, 2]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("is replaced by the page's own at once when it throws, and the next request still works", () => {
    const { h, applied } = hooks();
    let bad = true;
    const compute: Compute = () => {
      if (bad) throw new Error('a bug');
      return none;
    };
    const r = new Recomputer(h, compute);
    // A throwing compute: the page takes over, and the page's own compute is the real model, which works on an empty network.
    expect(() => r.run(1)).not.toThrow();
    expect(applied).toEqual([1]);
    bad = false;
    r.run(2);
    expect(applied).toEqual([1, 2]);
  });

  it('is not stuck when the source cannot be read', () => {
    let bad = true;
    const applied: number[] = [];
    const h: Hooks = {
      source: () => {
        if (bad) throw new Error('state in a mess');
        return { nodes: new Map(), picks: new Map(), triggers: [], heard: [] };
      },
      apply: (_o, now) => void applied.push(now),
      emit() {},
    };
    const r = new Recomputer(h);
    expect(() => r.run(1)).not.toThrow();
    expect(applied).toEqual([]);
    bad = false;
    r.run(2);
    expect(applied).toEqual([2]);
  });

  it('stops the worker when it moves to the page, even if the worker itself was fine', () => {
    const dispose = vi.fn();
    const worker: Compute = Object.assign((): ModelOutput => none, { dispose });
    let bad = true;
    const applied: number[] = [];
    const h: Hooks = {
      source: () => {
        if (bad) throw new Error('state in a mess');
        return { nodes: new Map(), picks: new Map(), triggers: [], heard: [] };
      },
      apply: (_o, now) => void applied.push(now),
      emit() {},
    };
    const r = new Recomputer(h, worker);
    r.run(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    bad = false;
    r.run(2);
    expect(applied).toEqual([2]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('a screen that throws when told does not stop the request that came in meanwhile', async () => {
    const { h, applied } = hooks();
    let fail = true;
    h.emit = () => {
      if (fail) throw new Error('a listener broke');
    };
    let release: () => void = () => {};
    const r = new Recomputer(h, () => new Promise((done) => (release = () => done(none))));
    r.run(1);
    r.run(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([1, 2]);
  });
});
