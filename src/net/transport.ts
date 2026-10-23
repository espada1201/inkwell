import { getEventHash, validateEvent, type Event } from 'nostr-tools/pure';
import { matchFilters, type Filter } from 'nostr-tools/filter';

export type RelayState = 'connecting' | 'open' | 'closed';
export interface RelayStatus {
  url: string;
  state: RelayState;
  received: number;
  /** Failed attempts since the relay was last open. */
  failures: number;
}

/**
 * The relays at a glance: one is open; or some are still on their first try; or all are down.
 * A relay retrying after a failure is down, so the answer does not flicker with every retry.
 */
export function reach(st: RelayStatus[]): 'open' | 'connecting' | 'down' {
  if (st.some((s) => s.state === 'open')) return 'open';
  return st.some((s) => s.state === 'connecting' && !s.failures) ? 'connecting' : 'down';
}

/** The seam between Tremor and the outside world. Production: public Nostr relays. Tests: a local fake. */
export interface Transport {
  publish(ev: Event): void;
  /** Filters given as a function are worked out afresh on every (re)subscription. */
  subscribe(filters: Filter[] | (() => Filter[]), onEvent: (ev: Event) => void): () => void;
  statuses(): RelayStatus[];
  onStatus(cb: () => void): void;
  close(): void;
}

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];

/** A relay address Tremor opens: secure, or plain only to a relay on this computer, as in development. A secure page cannot open a plain socket to another host. */
export const isRelayUrl = (s: unknown): s is string => typeof s === 'string' && /^(wss:\/\/[^\s/]+|ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/\S*)?$/.test(s);

interface Sub {
  id: string;
  make: () => Filter[];
  filters: Filter[];
  onEvent: (ev: Event) => void;
}

const req = (s: Sub) => ['REQ', s.id, ...(s.filters = s.make())];

export const RETRY_FIRST_MS = 1000;
export const RETRY_CAP_MS = 5 * 60_000;
/** The longest wait while this browser is a sensor: its picks and heartbeats should not sit in a queue of 50 for five minutes. */
export const RETRY_CAP_SENSOR_MS = 60_000;
/** Coming back to a tab retries a down relay, but not more often than this: each refused try is a line in the console. */
const VISIBLE_RETRY_GAP_MS = 10_000;

/** A wait of 70% to 130% of `ms`, so phones that lost the network together do not all come back on the same second. */
const jitter = (ms: number) => ms * (0.7 + 0.6 * Math.random());

/** Minimal NIP-01 client: one socket per relay, reconnect with backoff, resubscribe, de-duplicate. */
class RelayConn {
  status: RelayStatus;
  private ws: WebSocket | null = null;
  private backoff = RETRY_FIRST_MS;
  private queue: string[] = [];
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the waiting retry is due, if one is waiting. */
  private due: number | null = null;
  private attempted = 0;

  constructor(
    url: string,
    private readonly subs: Map<string, Sub>,
    private readonly deliver: (subId: string, ev: Event) => void,
    private readonly changed: () => void,
    private readonly cap: () => number = () => RETRY_CAP_MS,
  ) {
    this.status = { url, state: 'connecting', received: 0, failures: 0 };
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.due = null;
    this.attempted = Date.now();
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.status.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = RETRY_FIRST_MS;
      this.status.failures = 0;
      this.setState('open');
      for (const s of this.subs.values()) ws.send(JSON.stringify(req(s)));
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (m) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (Array.isArray(msg) && msg[0] === 'EVENT' && typeof msg[1] === 'string' && msg[2] && typeof msg[2] === 'object') {
        this.status.received++;
        this.deliver(msg[1], msg[2] as Event);
      }
    };
    // A failed socket fires error and then close in browsers, but only error in Node: the first one counts.
    const failed = () => {
      if (this.ws !== ws) return;
      this.retry();
      ws.close();
    };
    ws.onerror = failed;
    ws.onclose = failed;
  }

  private retry() {
    this.ws = null;
    this.status.failures++;
    this.setState('closed');
    if (this.closed) return;
    this.wait(Math.min(this.backoff, this.cap()));
    this.backoff = Math.min(this.backoff * 2, RETRY_CAP_MS);
  }

  private wait(ms: number) {
    clearTimeout(this.timer);
    const delay = jitter(ms);
    this.due = Date.now() + delay;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /** At once, from the first wait again; `minGap` ms at least since the last try. */
  retryNow(minGap = 0) {
    if (this.closed || this.status.state !== 'closed' || Date.now() - this.attempted < minGap) return;
    clearTimeout(this.timer);
    this.backoff = RETRY_FIRST_MS;
    this.connect();
  }

  /** The cap came down: a wait longer than it allows is shortened to it. */
  recap() {
    const cap = this.cap();
    this.backoff = Math.min(this.backoff, cap);
    if (this.due !== null && this.due - Date.now() > cap * 1.3) this.wait(cap);
  }

  private setState(s: RelayState) {
    this.status.state = s;
    this.changed();
  }

  send(msg: unknown, queueIfDown: boolean) {
    const text = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else if (queueIfDown) this.queue = [...this.queue, text].slice(-50);
  }

  publish(ev: Event) {
    this.send(['EVENT', ev], true);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.setState('closed');
  }
}

export class RelayPool implements Transport {
  private readonly subs = new Map<string, Sub>();
  private readonly conns: RelayConn[];
  private readonly seen = new Set<string>();
  private listeners: (() => void)[] = [];
  private n = 0;

  private sensor = false;

  private readonly online = () => this.conns.forEach((c) => c.retryNow());
  private readonly visible = () => {
    if (document.visibilityState === 'visible') this.conns.forEach((c) => c.retryNow(VISIBLE_RETRY_GAP_MS));
  };

  constructor(urls: string[]) {
    this.conns = urls.map((u) => new RelayConn(u, this.subs, (id, ev) => this.deliver(id, ev), () => this.emit(), () => (this.sensor ? RETRY_CAP_SENSOR_MS : RETRY_CAP_MS)));
    if (typeof window !== 'undefined') window.addEventListener('online', this.online);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visible);
  }

  /** Whether this browser is reporting as a sensor: then a down relay is retried at least every minute. */
  setSensorActive(on: boolean) {
    if (on === this.sensor) return;
    this.sensor = on;
    if (on) this.conns.forEach((c) => c.recap());
  }

  private deliver(subId: string, ev: Event) {
    const sub = this.subs.get(subId);
    // Relays can send anything: check the shape before nostr-tools touches it, and that the id
    // is the event's hash, so a doctored copy cannot take the real one's place. `parse` checks
    // signatures; a copy with a bad one is told apart from the real one by it.
    if (!sub || !validateEvent(ev) || typeof ev.id !== 'string' || typeof ev.sig !== 'string') return;
    const key = `${subId}:${ev.id}:${ev.sig}`;
    if (this.seen.has(key) || getEventHash(ev) !== ev.id || !matchFilters(sub.filters, ev)) return;
    this.seen.add(key);
    if (this.seen.size > 20_000) this.seen.clear();
    sub.onEvent(ev);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  publish(ev: Event) {
    for (const c of this.conns) c.publish(ev);
  }

  subscribe(filters: Filter[] | (() => Filter[]), onEvent: (ev: Event) => void) {
    const id = `tremor-${++this.n}`;
    const sub: Sub = { id, make: typeof filters === 'function' ? filters : () => filters, filters: [], onEvent };
    this.subs.set(id, sub);
    for (const c of this.conns) c.send(req(sub), false);
    return () => {
      this.subs.delete(id);
      for (const c of this.conns) c.send(['CLOSE', id], false);
    };
  }

  statuses() {
    return this.conns.map((c) => ({ ...c.status }));
  }

  onStatus(cb: () => void) {
    this.listeners.push(cb);
  }

  close() {
    if (typeof window !== 'undefined') window.removeEventListener('online', this.online);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visible);
    for (const c of this.conns) c.close();
    this.listeners = [];
  }
}
