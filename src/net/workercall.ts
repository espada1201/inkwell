/** The part of a Worker `workerCall` uses, so tests can stand in for one. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

/** How long a question may go unanswered before the worker is taken for dead: long past the slowest honest answer, short enough that a stuck page recovers. */
export const WORKER_TIMEOUT_MS = 10_000;

export class WorkerFailed extends Error {}

interface Waiting<R> {
  done: (r: R) => void;
  fail: (why: WorkerFailed) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Questions to one worker and their answers, matched by id. When the worker cannot answer it
 * is stopped for good, whichever way it failed: an error event, a message that could not be
 * read, an answer that says it threw, a question that could not be posted, or no answer
 * within `timeoutMs` (a timer runs only while a question is waiting). Everything waiting and
 * everything asked after fails the same way, by the caller's choice:
 *  - with a `fallback`, the call answers with `fallback(args)` instead, on the caller's own
 *    thread (a throw there rejects that call alone);
 *  - without one, the call rejects with `WorkerFailed`.
 * `onBroken` runs once, when the worker is given up on.
 */
export function workerCall<A, R>(worker: WorkerLike, { timeoutMs = WORKER_TIMEOUT_MS, onBroken }: { timeoutMs?: number; onBroken?: () => void } = {}) {
  const waiting = new Map<number, Waiting<R>>();
  let broken: WorkerFailed | null = null;
  let n = 0;

  const giveUp = (why: string) => {
    if (broken) return;
    broken = new WorkerFailed(why);
    worker.terminate();
    const jobs = [...waiting.values()];
    waiting.clear();
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.fail(broken);
    }
    onBroken?.();
  };

  worker.onmessage = (e) => {
    const { id, result, error } = e.data as { id: number; result?: R; error?: string };
    const job = waiting.get(id);
    if (!job) return;
    waiting.delete(id);
    clearTimeout(job.timer);
    if (error === undefined) return job.done(result as R);
    waiting.set(id, job);
    giveUp(error);
  };
  worker.onerror = () => giveUp('the worker raised an error');
  worker.onmessageerror = () => giveUp('a message to or from the worker could not be read');

  return {
    /** Gives up on the worker now, as if it had failed: for a caller that has others and gives up on them all together. */
    stop: () => giveUp('stopped'),
    get broken() {
      return broken !== null;
    },
    call(args: A, fallback?: (args: A) => R): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        const fail = (why: WorkerFailed) => {
          if (!fallback) return reject(why);
          try {
            resolve(fallback(args));
          } catch (e) {
            reject(e);
          }
        };
        if (broken) return fail(broken);
        const id = ++n;
        const timer = setTimeout(() => giveUp(`no answer in ${timeoutMs} ms`), timeoutMs);
        waiting.set(id, { done: resolve, fail, timer });
        try {
          worker.postMessage({ id, args });
        } catch (e) {
          giveUp(`could not post: ${e}`);
        }
      });
    },
  };
}

/** The worker's end of `workerCall`: answers each question with `handler(args)`, or says it failed. */
export function serve<A, R>(scope: { onmessage: ((e: MessageEvent) => void) | null; postMessage(message: unknown): void }, handler: (args: A) => R) {
  scope.onmessage = (e) => {
    const { id, args } = e.data as { id: number; args: A };
    try {
      scope.postMessage({ id, result: handler(args) });
    } catch (err) {
      scope.postMessage({ id, error: String(err) });
    }
  };
}
