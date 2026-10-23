import type { Event } from 'nostr-tools/pure';
import { parse, type Message } from './protocol';
import type { VerifyReply, VerifyRequest } from './verify.worker';

/** Checks a batch of relay events, as of `now`: the message each one carries, or null for one that fails its checks. Answers come back in the order asked. */
export type Verify = (events: Event[], now: number) => Promise<(Message | null)[]>;

/**
 * Signature checks cost about 2 ms each, and a big network sends thousands of heartbeats the
 * moment a page opens. A few workers check them off the page's thread; with none (or if they
 * fail), the page checks them itself.
 */
export function workerVerifier(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))): Verify | null {
  const waiting = new Map<number, { events: Event[]; now: number; done: (m: (Message | null)[]) => void }>();
  const workers: Worker[] = [];
  let broken = false;
  let n = 0;
  const here = (events: Event[], now: number) => events.map((ev) => parse(ev, now));
  const fail = () => {
    broken = true;
    workers.forEach((w) => w.terminate());
    for (const { events, now, done } of waiting.values()) done(here(events, now));
    waiting.clear();
  };
  try {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<VerifyReply>) => {
        const job = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        job?.done(e.data.messages);
      };
      w.onerror = fail;
      workers.push(w);
    }
  } catch {
    workers.forEach((w) => w.terminate());
    return null;
  }
  return (events, now) =>
    broken
      ? Promise.resolve(here(events, now))
      : new Promise((done) => {
          const id = ++n;
          waiting.set(id, { events, now, done });
          workers[id % workers.length].postMessage({ id, events, now } satisfies VerifyRequest);
        });
}
