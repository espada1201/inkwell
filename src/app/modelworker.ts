import type { Compute, ModelOutput } from './model';
import type { ModelReply, ModelRequest } from './model.worker';

/**
 * The association, location and quiet phones' veto in a worker, so a big network's recompute
 * never holds the page. Without workers, or if this one fails, the page works it out itself.
 */
export function workerModel(): Compute | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const waiting = new Map<number, { done: (o: ModelOutput) => void; fail: () => void }>();
  let n = 0;
  worker.onmessage = (e: MessageEvent<ModelReply>) => {
    const job = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    job?.done(e.data.output);
  };
  worker.onerror = () => {
    worker.terminate();
    for (const { fail } of waiting.values()) fail();
    waiting.clear();
  };
  return (delta) =>
    new Promise((done, fail) => {
      const request: ModelRequest = { id: ++n, delta };
      waiting.set(request.id, { done, fail });
      worker.postMessage(request);
    });
}
