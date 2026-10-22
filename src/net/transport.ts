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

/** Minimal NIP-01 client: one socket per relay, reconnect with backoff, resubscribe, de-duplicate. */
class RelayConn {
  status: RelayStatus;
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private queue: string[] = [];
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    url: string,
    private readonly subs: Map<string, Sub>,
    private readonly deliver: (subId: string, ev: Event) => void,
    private readonly changed: () => void,
  ) {
    this.status = { url, state: 'connecting', received: 0, failures: 0 };
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.status.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
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
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
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

  constructor(urls: string[]) {
    this.conns = urls.map((u) => new RelayConn(u, this.subs, (id, ev) => this.deliver(id, ev), () => this.emit()));
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
    for (const c of this.conns) c.close();
    this.listeners = [];
  }
}
