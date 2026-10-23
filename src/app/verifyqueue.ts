import type { Event } from 'nostr-tools/pure';
import { eventKind, type EventKind, type Message } from '../net/protocol';
import type { Verify } from '../net/verifier';

const CHECK_EVERY_MS = 20;
const CHECK_BATCH = 64;
/** Waiting to be checked or being checked: past it, picks and heartbeats are dropped. */
export const MAX_UNCHECKED = 50_000;
/** Past twice that, anything is: memory stays bounded however many events a relay sends. */
const MAX_UNCHECKED_ANY = 2 * MAX_UNCHECKED;

/**
 * Events waiting for their signatures to be checked, in batches, and handed on in the order
 * they came in. A flood does not queue without end: past MAX_UNCHECKED the cheap-to-lose kinds
 * (picks come again with the next shaking, heartbeats with the next minute) are dropped first,
 * so retractions and confirmed reports still get through; past twice that, everything is. What
 * was dropped is counted by kind.
 *
 * Nothing that goes wrong with one event or one batch stops the rest: a message the receiver
 * chokes on is logged and skipped, a batch whose check fails is dropped, and either way its
 * events leave the backlog.
 */
export class VerifyQueue {
  /** Events dropped for want of room, by what they claimed to be. */
  readonly shed: Record<EventKind, number> = { heartbeat: 0, pick: 0, trigger: 0, retract: 0, felt: 0, other: 0 };
  /** Events taken and not yet handed on or dropped. */
  backlog = 0;
  private waiting: Event[] = [];
  private flying = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inOrder: Promise<void> = Promise.resolve();

  constructor(
    private readonly verify: Verify,
    private readonly deliver: (m: Message) => void,
  ) {}

  get dropped() {
    return Object.values(this.shed).reduce((a, b) => a + b, 0);
  }

  push(ev: Event) {
    const kind = eventKind(ev);
    if (this.backlog >= MAX_UNCHECKED_ANY || (this.backlog >= MAX_UNCHECKED && (kind === 'pick' || kind === 'heartbeat'))) {
      this.shed[kind]++;
      return;
    }
    this.backlog++;
    this.waiting.push(ev);
    this.pump(false);
  }

  /**
   * Send full batches while the verifier has room (`slots`, or no limit), and the rest 20 ms after
   * they began to wait or, with no room then, as soon as there is. What is held here is counted
   * in `backlog` like what is out, so a flood is shed the same.
   */
  private pump(flush: boolean) {
    const room = this.verify.slots ?? Infinity;
    while (this.flying < room && this.waiting.length && (flush || this.waiting.length >= CHECK_BATCH)) this.send();
    if (this.waiting.length && this.timer === undefined && this.flying < room)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump(true);
      }, CHECK_EVERY_MS);
  }

  private send() {
    const batch = this.waiting.splice(0, CHECK_BATCH);
    let checked: Promise<(Message | null)[]>;
    try {
      checked = this.verify(batch, Date.now()).catch(() => []);
    } catch {
      checked = Promise.resolve([]);
    }
    this.flying++;
    void checked.then(() => {
      this.flying--;
      this.pump(false);
    });
    this.inOrder = this.inOrder
      .then(() => checked)
      .then((messages) => {
        for (const m of messages) {
          if (!m) continue;
          try {
            this.deliver(m);
          } catch (e) {
            console.error(e);
          }
        }
      })
      .finally(() => {
        this.backlog -= batch.length;
      });
  }
}
