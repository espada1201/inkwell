/// <reference lib="webworker" />
import type { Event } from 'nostr-tools/pure';
import { parse, type Message } from './protocol';

export interface VerifyRequest {
  id: number;
  events: Event[];
  now: number;
}
export interface VerifyReply {
  id: number;
  messages: (Message | null)[];
}

self.onmessage = (e: MessageEvent<VerifyRequest>) => {
  const { id, events, now } = e.data;
  postMessage({ id, messages: events.map((ev) => parse(ev, now)) } satisfies VerifyReply);
};
