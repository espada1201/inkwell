import { LiveNetwork } from '../../src/app/live';
import type { Transport } from '../../src/net/transport';
import { crowd, measure, verifyCost } from '../scale';

const none: Transport = { publish() {}, subscribe: () => () => {}, statuses: () => [], onStatus() {}, close() {} };
const fetchNone = (async () => new Response('{}', { status: 503 })) as typeof fetch;

const sizes = (process.argv[2] ?? '1000,3000,10000').split(',').map(Number);
console.log(`check one signed event: ${verifyCost().toFixed(2)} ms`);
console.log(['phones', 'picks', 'heartbeats', 'messages', 'recompute max', 'sum', 'repeat', 'screen', 'prune'].join('\t'));
for (const n of sizes) {
  const c = crowd(n);
  const t = measure(c, new LiveNetwork(none, 'hour', fetchNone));
  console.log([n, c.picks.length, t.heartbeats, t.messages, t.recomputeMax, t.recomputeSum, t.recomputeRepeat, t.screen, t.prune].map((v) => (typeof v === 'number' ? Math.round(v) : v)).join('\t'), `\t(${t.events} quake, ${t.provisional} provisional)`);
}
