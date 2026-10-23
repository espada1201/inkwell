/// <reference lib="webworker" />
import type { Event } from 'nostr-tools/pure';
import { parse, type Message } from './protocol';
import { serve } from './workercall';

serve<{ events: Event[]; now: number }, (Message | null)[]>(self, ({ events, now }) => events.map((ev) => parse(ev, now)));
