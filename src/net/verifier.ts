import type { Event } from 'nostr-tools/pure';
import { parse, type Message } from './protocol';
import { workerCall } from './workercall';

export type Verify = (events: Event[], now: number) => Promise<(Message | null)[]>;

interface Batch {
  events: Event[];
  now: number;
}

/**
 * Signature checks in up to `size` workers, a batch to each in turn. When any worker fails, they
 * all stop and every batch, those waiting and those after, is checked on the page instead:
 * slower, never lost.
 */
export function workerVerifier(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))): Verify | null {
  const here = ({ events, now }: Batch) => events.map((ev) => parse(ev, now));
  const workers: Worker[] = [];
  const asks: ReturnType<typeof workerCall<Batch, (Message | null)[]>>[] = [];
  let n = 0;
  try {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      asks.push(workerCall<Batch, (Message | null)[]>(w, { onBroken: () => asks.forEach((a) => a.stop()) }));
    }
  } catch {
    workers.forEach((w) => w.terminate());
    return null;
  }
  return (events, now) => asks[++n % asks.length].call({ events, now }, here);
}
