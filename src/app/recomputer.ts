import type { Trigger } from '../core/associate';
import type { Onset } from '../core/early';
import { ModelSender, mainThread, type Compute, type ModelNode, type ModelOutput } from './model';

/** A new pick, trigger or withdrawal is worked into the picture this soon: early warning does not wait on how dear the last recompute was. */
export const EARLY_DELAY_MS = 200;
/** A candidate that holds for now is looked at again this soon, for the phones the wave is still reaching. */
export const WAITING_RECHECK_MS = 500;
const MAX_REST_MS = 2000;

/** What the model is worked out from: the page's own collections, read afresh at each run. */
export interface ModelSource {
  nodes: Map<string, ModelNode>;
  picks: Map<string, Trigger>;
  triggers: Trigger[];
  heard: Onset[];
}

export interface Hooks {
  source(): ModelSource;
  /** Take an answer in: `now` is the time it was worked out for. */
  apply(out: ModelOutput, now: number): void;
  /** Something the screens show has changed. */
  emit(): void;
}

const isPromise = <T>(x: T | Promise<T>): x is Promise<T> => typeof (x as Promise<T>)?.then === 'function';

/**
 * When and where the quake model is worked out. One run at a time (single flight): a request
 * that comes in meanwhile is remembered and served the moment the run is done. A request is
 * either early (a new pick, trigger or withdrawal: after EARLY_DELAY_MS whatever the last run
 * cost) or not (a heartbeat, a felt report, a prune: after three times the last run's cost on
 * the page, 200 ms to 2 s, so a big network does not recompute back to back).
 *
 * `compute` takes the changes since the last run and answers at once or later. If it fails, by
 * throwing, rejecting or never answering (a worker's own watchdog turns that into a rejection),
 * the model is worked out on the page from then on, from a fresh start: the worker's picture
 * died with it, and the worker is let go. If the page's own computation fails there is nowhere left to fall back to: the
 * failure is logged, and the next request tries again.
 */
export class Recomputer {
  private sender = new ModelSender();
  private compute: Compute;
  private onPage: boolean;
  private flying = false;
  /** Asked for while a run was on its way: early, and the time given if it was given one. */
  private pending: { early: boolean; now?: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due = 0;
  private timerEarly = false;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  /** Milliseconds the page itself spent on the last run. */
  private cost = 0;

  constructor(
    private readonly hooks: Hooks,
    compute?: Compute,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.onPage = !compute;
    this.compute = compute ?? mainThread();
  }

  /** Run soon: early or not (see the class). */
  request(early: boolean) {
    const due = this.clock() + (early ? EARLY_DELAY_MS : Math.min(MAX_REST_MS, Math.max(EARLY_DELAY_MS, 3 * this.cost)));
    if (this.timer !== undefined) {
      if (this.due <= due) return;
      clearTimeout(this.timer);
    }
    this.due = due;
    this.timerEarly = early;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run(undefined, this.timerEarly);
    }, due - this.clock());
  }

  /** Run now, or when the run on its way is done, for `now` (the time of day by default). */
  run(now?: number, early = false) {
    clearTimeout(this.recheck);
    this.recheck = undefined;
    if (this.flying) {
      this.pending = { early: early || !!this.pending?.early, now: now ?? this.pending?.now };
      return;
    }
    this.start(now ?? this.clock());
  }

  private start(now: number) {
    const began = this.clock();
    this.flying = true;
    let answer: ModelOutput | Promise<ModelOutput>;
    try {
      const { nodes, picks, triggers, heard } = this.hooks.source();
      const delta = this.sender.delta(now, nodes, picks, triggers, heard);
      this.cost = this.clock() - began;
      answer = this.compute(delta);
    } catch (e) {
      return this.failed(e, now);
    }
    if (isPromise(answer)) answer.then((out) => this.done(out, now, began, true), (e) => this.failed(e, now));
    else this.done(answer, now, began, false);
  }

  private done(out: ModelOutput, now: number, began: number, apart: boolean) {
    this.flying = false;
    const applied = this.clock();
    try {
      this.hooks.apply(out, now);
    } catch (e) {
      console.error(e);
    }
    this.cost = apart ? Math.max(this.clock() - applied, (applied - began) / 3) : this.clock() - began;
    if (out.waiting) this.recheck = setTimeout(() => this.run(), WAITING_RECHECK_MS);
    try {
      this.hooks.emit();
    } catch (e) {
      console.error(e);
    }
    this.next();
  }

  private failed(e: unknown, now: number) {
    this.flying = false;
    console.error(e);
    this.sender = new ModelSender();
    const retry = !this.onPage;
    this.onPage = true;
    // Whatever failed, the worker's picture is no longer the sender's: let the worker go.
    this.compute.dispose?.();
    this.compute = mainThread();
    if (retry) this.start(now);
    else this.next();
  }

  /** Serve what was asked for while a run was on its way. */
  private next() {
    const p = this.pending;
    if (!p || this.flying) return;
    this.pending = null;
    if (p.early || p.now !== undefined) this.start(p.now ?? this.clock());
    else this.request(false);
  }
}
