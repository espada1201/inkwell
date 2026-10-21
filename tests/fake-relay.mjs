// A tiny in-process Nostr relay (NIP-01 subset) for tests: real relays are unreachable in CI.
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import { matchFilters } from 'nostr-tools/filter';

const safeMatch = (filters, ev) => {
  try {
    return matchFilters(filters, ev);
  } catch {
    return false;
  }
};

/** `verify: false` makes a hostile relay that forwards anything, to test client-side checks. */
export function startRelay(port = 0, { verify = true } = {}) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  let events = [];
  const subs = new Map();

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const [type, ...rest] = msg;
      if (type === 'EVENT') {
        const ev = rest[0];
        if (!ev || typeof ev !== 'object') return;
        if (verify && !verifyEvent(ev)) return ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
        const ephemeral = ev.kind >= 20000 && ev.kind < 30000;
        if (ev.kind >= 30000 && ev.kind < 40000) {
          const d = ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
          events = events.filter((e) => !(e.kind === ev.kind && e.pubkey === ev.pubkey && (e.tags.find((t) => t[0] === 'd')?.[1] ?? '') === d));
        }
        if (!ephemeral && !events.some((e) => e.id === ev.id)) events.push(ev);
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        for (const [client, m] of subs) for (const [id, filters] of m) if (safeMatch(filters, ev)) client.send(JSON.stringify(['EVENT', id, ev]));
      } else if (type === 'REQ') {
        const [id, ...filters] = rest;
        subs.get(ws).set(id, filters);
        for (const ev of events) if (safeMatch(filters, ev)) ws.send(JSON.stringify(['EVENT', id, ev]));
        ws.send(JSON.stringify(['EOSE', id]));
      } else if (type === 'CLOSE') {
        subs.get(ws).delete(rest[0]);
      }
    });
  });

  return new Promise((resolve) =>
    wss.on('listening', () =>
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        events: () => events,
        close: () => new Promise((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => r());
        }),
      }),
    ),
  );
}

