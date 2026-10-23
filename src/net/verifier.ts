import type { Event } from 'nostr-tools/pure';
import { parse, type Message } from './protocol';
import { workerCall } from './workercall';

export type Verify = ((events: Event[], now: number) => Promise<(Message | null)[]>) & {
  /** Batches it can work on at once: more are held by the caller, not queued inside. */
  slots?: number;
};

const PER_WORKER = 2;

interface Batch {
  events: Event[];
  now: number;
}

/**
 * Signature checks in up to `size` workers, each batch to the one with the fewest out, at most two per worker (`slots` says so: the caller holds the rest). When any worker fails, they
 * all stop and every batch, those waiting and those after, is checked on the page instead:
 * slower, never lost.
 */
export function workerVerifier(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))): Verify | null {
  const here = ({ events, now }: Batch) => events.map((ev) => parse(ev, now));
  const workers: Worker[] = [];
  const asks: ReturnType<typeof workerCall<Batch, (Message | null)[]>>[] = [];
  const out: number[] = [];
  try {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      out.push(0);
      asks.push(workerCall<Batch, (Message | null)[]>(w, { onBroken: () => asks.forEach((a) => a.stop()) }));
    }
  } catch {
    workers.forEach((w) => w.terminate());
    return null;
  }
  // The worker with the fewest batches out: with `slots` batches out in all, none has more than PER_WORKER.
  const verify: Verify = (events, now) => {
    const i = out.indexOf(Math.min(...out));
    out[i]++;
    return asks[i].call({ events, now }, here).finally(() => out[i]--);
  };
  verify.slots = PER_WORKER * size;
  return verify;
}
