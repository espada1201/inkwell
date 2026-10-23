import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { workerModel } from '../../src/app/modelworker';
import type { ModelDelta, ModelOutput } from '../../src/app/model';
import { parse, signHeartbeat } from '../../src/net/protocol';
import { workerVerifier } from '../../src/net/verifier';

class StubWorker {
  static made: StubWorker[] = [];
  static refuse = false;
  sent: { id: number; args: unknown }[] = [];
  terminated = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  constructor() {
    if (StubWorker.refuse) throw new Error('no workers here');
    StubWorker.made.push(this);
  }
  postMessage(m: { id: number; args: unknown }) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated++;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', StubWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubWorker.made = [];
  StubWorker.refuse = false;
});

const delta = { now: 1 } as ModelDelta;
const output: ModelOutput = { events: [], early: [], waiting: false };

describe('the model worker as the page sees it', () => {
  it('has no worker where none can be made', () => {
    StubWorker.refuse = true;
    expect(workerModel()).toBeNull();
  });

  it('answers with what the worker says', async () => {
    const compute = workerModel()!;
    const [w] = StubWorker.made;
    const answer = compute(delta);
    w.onmessage?.({ data: { id: w.sent[0].id, result: output } } as MessageEvent);
    expect(await answer).toEqual(output);
  });

  for (const [name, breakIt] of [
    ['an error', (w: StubWorker) => w.onerror?.({} as ErrorEvent)],
    ['a message it could not read', (w: StubWorker) => w.onmessageerror?.({} as MessageEvent)],
    ['silence for ten seconds', () => vi.advanceTimersByTime(10_000)],
  ] as const) {
    it(`rejects what is waiting, and what is asked later, after ${name}, and stops the worker`, async () => {
      const compute = workerModel()!;
      const [w] = StubWorker.made;
      const waiting = Promise.allSettled([compute(delta)]);
      breakIt(w);
      expect((await waiting)[0].status).toBe('rejected');
      await expect(Promise.resolve(compute(delta))).rejects.toThrow();
      expect(w.terminated).toBe(1);
    });
  }
});

describe('the signature workers as the page sees them', () => {
  const events = () => [signHeartbeat(generateSecretKey(), { lat: 35, lon: -118, noise: 0.01, sps: 50 })];

  it('has no workers where none can be made', () => {
    StubWorker.refuse = true;
    expect(workerVerifier(2)).toBeNull();
  });

  it('sends batches to the workers in turn, and returns what they answer', async () => {
    const verify = workerVerifier(2)!;
    const evs = events();
    const a = verify(evs, Date.now());
    const b = verify(evs, Date.now());
    const holders = StubWorker.made.filter((w) => w.sent.length);
    expect(holders).toHaveLength(2);
    holders.forEach((w) => w.onmessage?.({ data: { id: w.sent[0].id, result: ['checked'] } } as MessageEvent));
    expect(await Promise.all([a, b])).toEqual([['checked'], ['checked']]);
  });

  it('when one worker fails, every batch, waiting or later, is checked on the page and all workers stop', async () => {
    const verify = workerVerifier(3)!;
    const evs = events();
    const now = Date.now();
    const waiting = [verify(evs, now), verify(evs, now), verify(evs, now)];
    StubWorker.made[1].onerror?.({} as ErrorEvent);
    const onPage = evs.map((ev) => parse(ev, now));
    expect(await Promise.all(waiting)).toEqual([onPage, onPage, onPage]);
    expect(await verify(evs, now)).toEqual(onPage);
    expect(StubWorker.made.map((w) => w.terminated)).toEqual([1, 1, 1]);
    expect(onPage[0]).not.toBeNull();
  });
});
