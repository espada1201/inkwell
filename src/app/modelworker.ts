import { workerCall } from '../net/workercall';
import type { Compute, ModelDelta, ModelOutput } from './model';

/**
 * The quake model in a worker. Its calls reject when the worker fails (error, unreadable
 * message, no answer in time), and the caller then does the work itself: there is no fallback
 * here, because only the caller knows what the worker was last told.
 */
export function workerModel(): Compute | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const ask = workerCall<ModelDelta, ModelOutput>(worker);
  return (delta) => ask.call(delta);
}
