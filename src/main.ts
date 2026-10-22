import './styles.css';
import { LiveNetwork } from './app/live';
import { Replay } from './app/replay';
import { SensorNode } from './app/sensor';
import { safeStorage } from './net/identity';
import { DEFAULT_RELAYS, RelayPool, reach } from './net/transport';
import { h } from './ui/dom';
import { startHelicorder } from './ui/helicorder';
import { QuakeMap, SHAKE_COLORS, type Swatch } from './ui/map';
import { aboutView } from './views/about';
import { NETWORK_LEGEND, REACH_DOT, networkView } from './views/network';
import { PLAN_LEGEND, planView } from './views/plan';
import { REPLAY_LEGEND, replayView } from './views/replay';
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

function saveRelays(urls: string[]) {
  safeStorage()?.setItem(RELAYS_KEY, JSON.stringify(urls));
  // A ?relays= link would otherwise win over the list just saved.
  if (params.has('relays')) location.replace(location.pathname + location.hash);
  else location.reload();
}

const logo = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 34 22');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M1 11h8l2-6 3 14 3-17 3 15 2-6h11" fill="none" stroke="#c8261c" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
  return svg;
};

const relays = relayList();
const transport = new RelayPool(relays);
const live = new LiveNetwork(transport, params.get('usgs') === 'hour' ? 'hour' : 'day');
const sensor = new SensorNode(transport);
const replay = new Replay();

const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
const relayStatus = h('span', { 'data-testid': 'relay-status' });
const usgsStatus = h('span', { class: 'usgs-status' });
const heli = h('canvas', { class: 'helicorder', 'aria-hidden': 'true', title: 'Activity: picks and triggers as they arrive, or the shaking in a replay' });
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

const WORLD = { center: { lat: 30, lon: -100 }, zoom: 2.2 };
const map = new QuakeMap(mapEl, WORLD);
map.ready.then(() => {
  if (map.offline) {
    mapNote.hidden = false;
    mapNote.textContent = 'Offline basemap: online map tiles unreachable.';
  }
});

function status() {
  const st = transport.statuses();
  const open = st.filter((s) => s.state === 'open').length;
  relayStatus.replaceChildren(h('i', { class: `dot ${REACH_DOT[reach(st)]}` }), `${open}/${st.length} relays`);
  usgsStatus.replaceChildren(h('i', { class: `dot ${live.usgsState === 'ok' ? 'ok' : live.usgsState === 'loading' ? 'warn' : 'bad'}` }), 'USGS');
}
live.on(status);

interface Tab {
  label: string;
  legend: Swatch[];
  /** The map key also explains the shaking colours. */
  shakeKey: boolean;
  /** The screen takes the place of the map and the panel. */
  fullScreen?: boolean;
  mount: (arg: string | undefined) => { el: HTMLElement; dispose: () => void };
}

/** Every screen, in tab order. */
const TABS = {
  network: {
    label: 'Network',
    legend: NETWORK_LEGEND,
    shakeKey: true,
    mount: () => {
      // The world first, so the view's own fly to the newest detection comes after and wins.
      map.fly(WORLD.center, WORLD.zoom);
      return networkView({ live, map, relays, saveRelays, place: sensor });
    },
  },
  replay: { label: 'Replay', legend: REPLAY_LEGEND, shakeKey: true, mount: (arg) => replayView(replay, map, arg, Number(params.get('speed')) || 1) },
  plan: { label: 'Plan', legend: PLAN_LEGEND, shakeKey: false, mount: (arg) => planView(map, arg) },
  sensor: { label: 'Be a sensor', legend: NETWORK_LEGEND, shakeKey: true, fullScreen: true, mount: () => sensorView(sensor) },
  about: { label: 'About', legend: NETWORK_LEGEND, shakeKey: true, mount: () => aboutView() },
} satisfies Record<string, Tab>;
type View = keyof typeof TABS;

let current: { view: View; dispose: () => void } | null = null;

function route() {
  const [name, ...rest] = location.hash.replace(/^#/, '').split('/');
  // Not `in`: that would also accept inherited names like "toString".
  const view: View = Object.hasOwn(TABS, name) ? (name as View) : 'network';
  if (current?.view === view) return;
  current?.dispose();
  const tab: Tab = TABS[view];
  tabs.replaceChildren(...(Object.keys(TABS) as View[]).map((v) => h('a', { href: `#${v}`, 'aria-current': v === view ? 'page' : null }, TABS[v].label)));
  sensorEl.hidden = !tab.fullScreen;
  mapEl.hidden = panel.hidden = !!tab.fullScreen;
  legendBody.replaceChildren(
    ...tab.legend.map(([c, l]) => h('span', {}, h('i', { style: `background:${c}` }), l)),
    ...(tab.shakeKey ? [h('span', { class: 'shake-key' }, h('b', { style: `background:linear-gradient(90deg, ${SHAKE_COLORS.slice(1).join(',')})` }), 'shaking felt')] : []),
  );
  const v = tab.mount(rest.join('/') || undefined);
  (tab.fullScreen ? sensorEl : panel).replaceChildren(v.el);
  if (!tab.fullScreen) panel.scrollTop = 0;
  current = { view, dispose: v.dispose };
  requestAnimationFrame(() => map.resize());
  document.title = `Tremor · ${tab.label}`;
}

startHelicorder(heli, () => (current?.view === 'replay' ? replay.activity() : live.activity()));
window.addEventListener('hashchange', route);
route();
status();
live.start();
