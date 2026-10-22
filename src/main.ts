import './styles.css';
import { LiveNetwork } from './app/live';
import { Replay } from './app/replay';
import { SensorNode } from './app/sensor';
import { safeStorage } from './net/identity';
import { DEFAULT_RELAYS, RelayPool, type Transport } from './net/transport';
import type { UsgsWindow } from './net/usgs';
import { h } from './ui/dom';
import { QuakeMap, SHAKE_COLORS } from './ui/map';
import { aboutView } from './views/about';
import { networkView } from './views/network';
import { planView } from './views/plan';
import { replayView } from './views/replay';
import { sensorView } from './views/sensor';

const params = new URLSearchParams(location.search);
const RELAYS_KEY = 'tremor.relays';

function relayList(): string[] {
  const fromUrl = params.get('relays');
  if (fromUrl) return fromUrl.split(',').filter(Boolean);
  try {
    const saved = JSON.parse(safeStorage()?.getItem(RELAYS_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_RELAYS;
}

type View = 'network' | 'replay' | 'plan' | 'sensor' | 'about';
const TABS: [View, string][] = [
  ['network', 'Network'],
  ['replay', 'Replay'],
  ['plan', 'Plan'],
  ['sensor', 'Be a sensor'],
  ['about', 'About'],
];

const logo = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 34 22');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M1 11h8l2-6 3 14 3-17 3 15 2-6h11" fill="none" stroke="#c8261c" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
  return svg;
};

let relays = relayList();
let transport: Transport = new RelayPool(relays);
const live = new LiveNetwork(transport, (params.get('usgs') as UsgsWindow) === 'hour' ? 'hour' : 'day');
const sensor = new SensorNode(transport);
const replay = new Replay();

const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
const relayStatus = h('span', { 'data-testid': 'relay-status' });
const usgsStatus = h('span', { class: 'usgs-status' });
const heli = h('canvas', { class: 'helicorder', 'aria-hidden': 'true' });
// MapLibre labels its own canvas as the "Map" region.
const mapEl = h('div', { class: 'map' });
const legendBody = h('div', { class: 'legend-body' });
const legend = h('details', { class: 'map-legend', open: matchMedia('(min-width: 901px)').matches }, h('summary', {}, 'Key'), legendBody);
const mapNote = h('div', { class: 'map-note', hidden: true });
const panel = h('aside', { class: 'panel', 'aria-live': 'off' });
const sensorEl = h('section', { class: 'sensor', hidden: true, 'aria-label': 'Sensor' });
const stage = h('main', { class: 'stage' }, mapEl, panel, sensorEl);
mapEl.append(legend, mapNote);
document.getElementById('app')!.append(
  h('header', { class: 'top' }, h('a', { class: 'brand', href: '#network', 'aria-label': 'Tremor home' }, logo(), h('b', {}, 'TREMOR')), tabs, h('div', { class: 'status' }, relayStatus, usgsStatus), heli),
  stage,
);

const map = new QuakeMap(mapEl, { center: { lat: 30, lon: -100 }, zoom: 2.2 });
map.ready.then(() => {
  if (map.offline) {
    mapNote.hidden = false;
    mapNote.textContent = 'Offline basemap: online map tiles unreachable.';
  }
});

function status() {
  const st = transport.statuses();
  const open = st.filter((s) => s.state === 'open').length;
  relayStatus.replaceChildren(h('i', { class: `dot ${open ? 'ok' : st.some((s) => s.state === 'connecting') ? 'warn' : 'bad'}` }), `${open}/${st.length} relays`);
  usgsStatus.replaceChildren(h('i', { class: `dot ${live.usgsState === 'ok' ? 'ok' : live.usgsState === 'loading' ? 'warn' : 'bad'}` }), 'USGS');
}
live.on(status);

let current: { view: View; dispose: () => void } | null = null;

function route() {
  const [name, ...rest] = location.hash.replace(/^#/, '').split('/');
  const arg = rest.join('/') || undefined;
  const view: View = (TABS.find(([v]) => v === name)?.[0] as View) ?? 'network';
  if (current?.view === view) return;
  current?.dispose();
  tabs.replaceChildren(...TABS.map(([v, label]) => h('a', { href: `#${v}`, 'aria-current': v === view ? 'page' : null }, label)));
  const isSensor = view === 'sensor';
  sensorEl.hidden = !isSensor;
  mapEl.hidden = panel.hidden = isSensor;
  const swatches =
    view === 'plan'
      ? [
          ['var(--ink)', 'phone (one simulation)'],
          ['var(--red)', 'simulated quake, detected'],
          ['transparent;border:1.5px solid var(--muted)', 'simulated quake, missed'],
        ]
      : view === 'replay'
      ? [
          ['var(--ink)', 'phone'],
          ['#e58a7c', 'felt shaking, still checking'],
          ['var(--red)', 'confirmed / Tremor epicentre'],
          ['var(--amber)', 'caught on-device'],
          ['transparent;border:2px solid var(--ink)', 'USGS epicentre'],
        ]
      : [
          ['var(--ink)', 'phone (node)'],
          ['transparent;border:2px solid var(--red)', 'provisional detection'],
          ['var(--red)', 'Tremor detection'],
          ['transparent;border:1.5px solid var(--ink)', 'USGS earthquake'],
        ];
  legendBody.replaceChildren(
    ...swatches.map(([c, l]) => h('span', {}, h('i', { style: `background:${c}` }), l)),
    ...(view === 'plan' ? [] : [h('span', { class: 'shake-key' }, h('b', { style: `background:linear-gradient(90deg, ${SHAKE_COLORS.slice(1).join(',')})` }), 'shaking felt')]),
  );
  let v: { el: HTMLElement; dispose: () => void };
  if (view === 'network') {
    v = networkView({
      live,
      map,
      relays,
      saveRelays: (urls) => {
        safeStorage()?.setItem(RELAYS_KEY, JSON.stringify(urls));
        location.reload();
      },
    });
    map.fly({ lat: 30, lon: -100 }, 2.2);
  } else if (view === 'replay') v = replayView(replay, map, arg, Number(params.get('speed')) || 1);
  else if (view === 'plan') v = planView(map, arg);
  else if (view === 'sensor') v = sensorView(sensor);
  else v = aboutView();
  (isSensor ? sensorEl : panel).replaceChildren(v.el);
  if (!isSensor) panel.scrollTop = 0;
  current = { view, dispose: v.dispose };
  requestAnimationFrame(() => map.resize());
  document.title = `Tremor · ${TABS.find(([x]) => x === view)![1]}`;
}

// Header helicorder: a pen drawing the network's pulse, scrolling right to left.
const heliTrace: number[] = [];
function helicorder() {
  const ctx = heli.getContext('2d')!;
  const w = (heli.width = heli.clientWidth);
  const hh = (heli.height = 16);
  const now = Date.now();
  const energy =
    current?.view === 'replay'
      ? replay.nodes.reduce((m, n) => Math.max(m, replay.shake(n)), 0)
      : Math.min(1, ([...live.picks.values()].filter((p) => now - p.t < 8000).length + live.triggers.filter((t) => now - t.t < 8000).length) / 6);
  heliTrace.push(energy * (0.5 + Math.random() * 0.5));
  const n = Math.ceil(w / 2);
  if (heliTrace.length > n) heliTrace.splice(0, heliTrace.length - n);
  ctx.clearRect(0, 0, w, hh);
  ctx.strokeStyle = '#c8261c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Quiet stretches leave the paper blank; shaking draws upward strokes onto the header rule.
  heliTrace.forEach((v, i) => {
    if (v < 0.02) return;
    const x = w - (heliTrace.length - i) * 2 + 0.5;
    ctx.moveTo(x, hh);
    ctx.lineTo(x, hh - 1 - v * 13);
  });
  ctx.stroke();
}
setInterval(helicorder, 120);

window.addEventListener('hashchange', route);
route();
status();
live.start();
