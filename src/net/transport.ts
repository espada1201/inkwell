import type { Event } from 'nostr-tools/pure';
import { matchFilters, type Filter } from 'nostr-tools/filter';

export type RelayState = 'connecting' | 'open' | 'closed';
export interface RelayStatus {
  url: string;
  state: RelayState;
  received: number;
}

/** The seam between Tremor and the outside world. Production: public Nostr relays. Tests: a local fake. */
export interface Transport {
  publish(ev: Event): void;
  subscribe(filters: Filter[], onEvent: (ev: Event) => void): () => void;
  statuses(): RelayStatus[];
  onStatus(cb: () => void): void;
  close(): void;
}

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];

interface Sub {
  id: string;
  filters: Filter[];
  onEvent: (ev: Event) => void;
}

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
    this.status = { url, state: 'connecting', received: 0 };
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
      this.setState('open');
      for (const s of this.subs.values()) ws.send(JSON.stringify(['REQ', s.id, ...s.filters]));
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
    ws.onclose = () => {
      if (this.ws === ws) this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    this.ws = null;
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
    if (!sub || typeof ev.id !== 'string' || this.seen.has(`${subId}:${ev.id}`)) return;
    if (!matchFilters(sub.filters, ev)) return;
    this.seen.add(`${subId}:${ev.id}`);
    if (this.seen.size > 20_000) this.seen.clear();
    sub.onEvent(ev);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  publish(ev: Event) {
    for (const c of this.conns) c.publish(ev);
  }

  subscribe(filters: Filter[], onEvent: (ev: Event) => void) {
    const id = `tremor-${++this.n}`;
    this.subs.set(id, { id, filters, onEvent });
    for (const c of this.conns) c.send(['REQ', id, ...filters], false);
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
