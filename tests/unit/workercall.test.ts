import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_TIMEOUT_MS, WorkerFailed, serve, workerCall, type WorkerLike } from '../../src/net/workercall';

class FakeWorker implements WorkerLike {
  sent: { id: number; args: unknown }[] = [];
  terminated = 0;
  throwOnPost = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  postMessage(m: unknown) {
    if (this.throwOnPost) throw new Error('DataCloneError');
    this.sent.push(m as { id: number; args: unknown });
  }
  terminate() {
    this.terminated++;
  }
  reply(id: number, result: unknown) {
    this.onmessage?.({ data: { id, result } } as MessageEvent);
  }
  refuse(id: number, error: string) {
    this.onmessage?.({ data: { id, error } } as MessageEvent);
  }
}

describe('asking a worker, and what happens when it cannot answer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives each caller the answer to its own question, whatever order the answers come in', async () => {
    const w = new FakeWorker();
    const ask = workerCall<string, string>(w);
    const a = ask.call('a');
    const b = ask.call('b');
    w.reply(w.sent[1].id, 'B');
    w.reply(w.sent[0].id, 'A');
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    expect(vi.getTimerCount()).toBe(0);
    expect(ask.broken).toBe(false);
  });

  const breakages: [string, (w: FakeWorker) => void][] = [
    ['an error event', (w) => w.onerror?.({})],
    ['a message that could not be read', (w) => w.onmessageerror?.({})],
    ['an answer that says it failed', (w) => w.refuse(w.sent[0].id, 'it threw')],
    ['no answer in time', () => vi.advanceTimersByTime(WORKER_TIMEOUT_MS)],
  ];

  for (const [name, breakIt] of breakages) {
    it(`rejects everything waiting, stops the worker, and rejects at once afterwards, on ${name}`, async () => {
      const w = new FakeWorker();
      const onBroken = vi.fn();
      const ask = workerCall<string, string>(w, { onBroken });
      const first = ask.call('a');
      const second = ask.call('b');
      const failures = Promise.allSettled([first, second]);
      breakIt(w);
      const [x, y] = await failures;
      expect(x.status).toBe('rejected');
      expect(y.status).toBe('rejected');
      expect((x as PromiseRejectedResult).reason).toBeInstanceOf(WorkerFailed);
      expect(w.terminated).toBe(1);
      expect(onBroken).toHaveBeenCalledTimes(1);
      expect(ask.broken).toBe(true);
      await expect(ask.call('c')).rejects.toBeInstanceOf(WorkerFailed);
      expect(w.sent).toHaveLength(2);
      // A late answer from a worker already given up on changes nothing.
      w.reply(w.sent[0].id, 'late');
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`answers from the fallback instead, for what was waiting and what is asked next, on ${name}`, async () => {
      const w = new FakeWorker();
      const ask = workerCall<string, string>(w);
      const fallback = (s: string) => s.toUpperCase();
      const first = ask.call('a', fallback);
      const second = ask.call('b', fallback);
      breakIt(w);
      expect(await Promise.all([first, second])).toEqual(['A', 'B']);
      expect(await ask.call('c', fallback)).toBe('C');
      expect(w.sent).toHaveLength(2);
    });
  }

  it('breaks when it cannot post, and the call that could not be posted fails like the rest', async () => {
    const w = new FakeWorker();
    w.throwOnPost = true;
    const ask = workerCall<string, string>(w);
    await expect(ask.call('a')).rejects.toBeInstanceOf(WorkerFailed);
    expect(ask.broken).toBe(true);
    expect(w.terminated).toBe(1);
    const viaFallback = workerCall<string, string>(w);
    expect(await viaFallback.call('b', (s) => s + '!')).toBe('b!');
  });

  it('a fallback that throws rejects that call, without leaving the rest waiting', async () => {
    const w = new FakeWorker();
    const ask = workerCall<string, string>(w);
    const bad = ask.call('a', () => {
      throw new Error('and the page cannot either');
    });
    const good = ask.call('b', (s) => s);
    const outcomes = Promise.allSettled([bad, good]);
    w.onerror?.({});
    expect((await outcomes).map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('can be stopped by its owner, which fails what waits like any other failure', async () => {
    const w = new FakeWorker();
    const ask = workerCall<string, string>(w);
    const waiting = ask.call('a', (s) => s + '?');
    ask.stop();
    ask.stop();
    expect(await waiting).toBe('a?');
    expect(w.terminated).toBe(1);
  });

  it('has a timer only while something is waiting, so a quiet worker is never taken for a dead one', async () => {
    const w = new FakeWorker();
    const ask = workerCall<string, string>(w);
    const a = ask.call('a');
    expect(vi.getTimerCount()).toBe(1);
    w.reply(w.sent[0].id, 'A');
    await a;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * WORKER_TIMEOUT_MS);
    expect(ask.broken).toBe(false);
  });
});

describe('the worker side', () => {
  const scope = () => {
    const posted: unknown[] = [];
    const s = { posted, onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => void posted.push(m) };
    return s;
  };
  const send = (s: ReturnType<typeof scope>, id: number, args: unknown) => s.onmessage?.({ data: { id, args } } as MessageEvent);

  it('answers with the handler result under the question id', () => {
    const s = scope();
    serve<number, number>(s, (n) => n * 2);
    send(s, 7, 21);
    expect(s.posted).toEqual([{ id: 7, result: 42 }]);
  });

  it('says so when the handler throws, instead of going quiet', () => {
    const s = scope();
    serve<number, number>(s, () => {
      throw new Error('boom');
    });
    send(s, 3, 1);
    expect(s.posted).toEqual([{ id: 3, error: 'Error: boom' }]);
  });

  it('says so when the answer cannot be posted', () => {
    const s = scope();
    let first = true;
    s.postMessage = (m) => {
      if (first) {
        first = false;
        throw new Error('DataCloneError');
      }
      s.posted.push(m);
    };
    serve<number, unknown>(s, () => () => {});
    send(s, 5, 1);
    expect(s.posted).toEqual([{ id: 5, error: 'Error: DataCloneError' }]);
  });
});
