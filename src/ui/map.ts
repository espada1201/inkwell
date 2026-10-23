import type { GeoJSONSource, MapLayerMouseEvent, Map as MlMap, Marker, Popup, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { offset, type LatLon } from '../core/geo';
import { h } from './dom';

const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/positron';

/** pick: felt shaking, still checking; trigger: confirmed; reject: withdrawn by the phone. */
export type NodeState = 'idle' | 'pick' | 'trigger' | 'reject' | 'offline';

export interface MapNode extends LatLon {
  id: string;
  state: NodeState;
  /** 0..1 current shaking, drives the halo in replay */
  shake?: number;
}
export interface MapEvent extends LatLon {
  id: string;
  mag: number | null;
  selected?: boolean;
  /** Declared from raw picks, not yet confirmed. */
  provisional?: boolean;
  members: LatLon[];
}
export interface MapRing {
  center: LatLon;
  km: number;
  /** The zone warned too late, a warning-time line, or how far off a located quake could be. */
  kind: 'blind' | 'iso' | 'error';
  label?: string;
}
export interface MapCell extends LatLon {
  halfKm: number;
  level: number;
}
export interface MapQuake extends LatLon {
  id: string;
  mag: number | null;
  /** 0 (now) .. 1 (oldest in window) */
  age: number;
}
/** Someone felt shaking here, this strong (intensity level, as `SHAKE_COLORS` counts). */
export interface MapFelt extends LatLon {
  lvl: number;
}
/** A simulated quake in the planner: was it caught? */
export interface MapTrial extends LatLon {
  hit: boolean;
}
export interface MapWaves {
  center: LatLon;
  pKm: number;
  sKm: number;
}

type FC = GeoJSON.FeatureCollection;
type Props = Record<string, unknown>;
const fc = (features: GeoJSON.Feature[]): FC => ({ type: 'FeatureCollection', features });
const feature = (geometry: GeoJSON.Geometry, properties: Props = {}): GeoJSON.Feature => ({ type: 'Feature', properties, geometry });
const at = (p: LatLon) => [p.lon, p.lat];
const pt = (p: LatLon, props: Props) => feature({ type: 'Point', coordinates: at(p) }, props);
function circle(c: LatLon, km: number) {
  return Array.from({ length: 97 }, (_, i) => {
    const a = (i / 96) * 2 * Math.PI;
    return at(offset(c, km * Math.cos(a), km * Math.sin(a)));
  });
}
const ring = (c: LatLon, km: number, props: Props) => feature({ type: 'LineString', coordinates: circle(c, km) }, props);
const disc = (c: LatLon, km: number, props: Props) => feature({ type: 'Polygon', coordinates: [circle(c, km)] }, props);
function square(c: LatLon, halfKm: number, props: Props) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([e, n]) => at(offset(c, e * halfKm, n * halfKm)));
  return feature({ type: 'Polygon', coordinates: [corners] }, props);
}

/** Intensity colours, weak → severe (index = intensity level). */
export const SHAKE_COLORS = ['rgba(0,0,0,0)', '#f3e7c4', '#efcf8e', '#e7a65e', '#d9773f', '#c4482a', '#94241a'];

const INK = '#1d1c1a';
const RED = '#c8261c';
const AMBER = '#a56a12';
const PAPER = '#f4f1e8';
const MUTED = '#6b675d';

/** How each phone state is drawn, on the map and in its key. */
export const NODE_COLORS: Record<NodeState, string> = { idle: INK, pick: '#e58a7c', trigger: RED, reject: AMBER, offline: '#a19d92' };

/** A map key entry: a CSS background for its swatch, and what it means. */
export type Swatch = [background: string, label: string];

const SOURCES = ['shake', 'rings', 'waves', 'links', 'usgs', 'trials', 'felt', 'nodes', 'events', 'truth'] as const;
type Source = (typeof SOURCES)[number];

/**
 * Land that crosses the antimeridian (Chukotka, Wrangel, Fiji) jumps from 180° to -180° and back,
 * and drawn flat each jump is a line across the world. Unwrapped, its longitudes run on past 180°.
 * Antarctica circles the pole and crosses only once, so it is left as it is.
 */
function unwrap(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  let prev = ring[0][0];
  const out = ring.map(([lon, lat]) => {
    prev = lon + 360 * Math.round((prev - lon) / 360);
    return [prev, lat];
  });
  if (Math.abs(out[out.length - 1][0] - out[0][0]) >= 180) return ring;
  // Keep the bulk of the land in -180..180, where it was.
  const shift = 360 * Math.round(-out.reduce((s, [lon]) => s + lon, 0) / out.length / 360);
  return out.map(([lon, lat]) => [lon + shift, lat]);
}

/** Minimal offline basemap: Natural Earth land, loaded only if the online style is unreachable. */
async function fallbackStyle(): Promise<StyleSpecification> {
  const [{ feature: toGeo }, land] = await Promise.all([import('topojson-client'), import('world-atlas/land-50m.json')]);
  const topo = ((land as { default?: unknown }).default ?? land) as Topology<{ land: GeometryCollection }>;
  const geo = toGeo(topo, topo.objects.land);
  for (const f of geo.features)
    if (f.geometry.type === 'MultiPolygon') f.geometry.coordinates = f.geometry.coordinates.map((p) => p.map(unwrap));
    else if (f.geometry.type === 'Polygon') f.geometry.coordinates = f.geometry.coordinates.map(unwrap);
  return {
    version: 8,
    sources: { land: { type: 'geojson', data: geo } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dfe3e0' } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': PAPER } },
      { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': '#9a968b', 'line-width': 0.6 } },
    ],
  };
}

async function pickStyle(): Promise<{ style: string | StyleSpecification; offline: boolean }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(BASEMAP_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) return { style: (await res.json()) as StyleSpecification, offline: false };
  } catch {
    /* fall through to offline map */
  }
  return { style: await fallbackStyle(), offline: true };
}

export class QuakeMap {
  map: MlMap | null = null;
  offline = false;
  readonly ready: Promise<void>;
  onSelect: (kind: 'event' | 'usgs', id: string) => void = () => {};
  /** What pressing a phone's dot says (its id in, a note out), or null for nothing. */
  nodeInfo: ((id: string) => string | null) | null = null;
  private pending = new Map<string, FC>();
  private lib: typeof import('maplibre-gl') | null = null;

  constructor(container: HTMLElement, view: { center: LatLon; zoom: number }) {
    // MapLibre is most of Tremor's code: it loads beside the style, so the screens do not wait for it.
    this.ready = Promise.all([pickStyle(), import('maplibre-gl')]).then(([{ style, offline }, lib]) => {
      this.offline = offline;
      lib.setWorkerUrl(workerUrl);
      let map: MlMap;
      try {
        map = new lib.Map({
          container,
          style,
          center: [view.center.lon, view.center.lat],
          zoom: view.zoom,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
          // On a touch screen one finger scrolls the page past the map, as everywhere else; two move the map.
          cooperativeGestures: matchMedia('(hover: none) and (pointer: coarse)').matches,
        });
      } catch {
        // No WebGL (very old device or locked-down browser): the lists still work.
        container.append(h('div', { class: 'map-error' }, 'The map needs WebGL, which this browser could not start. Everything else still works.'));
        return;
      }
      // Tile hiccups are routine on flaky networks; they should not surface as page errors.
      map.on('error', (e) => console.warn('map:', e.error?.message ?? e));
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      this.map = map;
      this.lib = lib;
      return new Promise<void>((resolve) => {
        map.once('load', () => {
          this.addLayers(map);
          for (const [id, data] of this.pending) (map.getSource(id) as GeoJSONSource).setData(data);
          this.pending.clear();
          resolve();
        });
      });
    }, () => void container.append(h('div', { class: 'map-error' }, 'The map could not load. Everything else still works.')));
  }

  private addLayers(map: MlMap) {
    for (const id of SOURCES) map.addSource(id, { type: 'geojson', data: fc([]) });
    map.addLayer({
      id: 'shake',
      type: 'fill',
      source: 'shake',
      paint: { 'fill-color': ['to-color', ['at', ['get', 'level'], ['literal', SHAKE_COLORS]]], 'fill-opacity': 0.55 },
    });
    map.addLayer({
      id: 'blind',
      type: 'fill',
      source: 'rings',
      filter: ['==', ['get', 'kind'], 'blind'],
      paint: { 'fill-color': RED, 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'rings',
      type: 'line',
      source: 'rings',
      paint: {
        'line-color': ['match', ['get', 'kind'], 'blind', RED, INK],
        'line-width': ['match', ['get', 'kind'], 'blind', 1.6, 0.9],
        'line-dasharray': [1, 2],
        'line-opacity': 0.8,
      },
    });
    map.addLayer({
      id: 'waves',
      type: 'line',
      source: 'waves',
      paint: {
        'line-color': ['match', ['get', 'phase'], 'P', INK, RED],
        'line-width': ['match', ['get', 'phase'], 'P', 1.2, 2.2],
        'line-dasharray': [3, 2],
        'line-opacity': 0.75,
      },
    });
    map.addLayer({ id: 'links', type: 'line', source: 'links', paint: { 'line-color': RED, 'line-width': 0.8, 'line-opacity': 0.45 } });
    map.addLayer({
      id: 'usgs',
      type: 'circle',
      source: 'usgs',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 1], 0, 3, 3, 5, 5, 10, 7, 18],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': INK,
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 1, 0.35],
      },
    });
    map.addLayer({
      id: 'trials',
      type: 'circle',
      source: 'trials',
      paint: {
        'circle-radius': 5,
        'circle-color': ['case', ['get', 'hit'], RED, 'rgba(0,0,0,0)'],
        'circle-stroke-color': ['case', ['get', 'hit'], PAPER, MUTED],
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'felt',
      type: 'circle',
      source: 'felt',
      paint: { 'circle-radius': 6, 'circle-color': ['to-color', ['at', ['get', 'lvl'], ['literal', SHAKE_COLORS]]], 'circle-stroke-color': INK, 'circle-stroke-width': 1 },
    });
    map.addLayer({
      id: 'nodes-halo',
      type: 'circle',
      source: 'nodes',
      filter: ['>', ['coalesce', ['get', 'shake'], 0], 0.02],
      paint: {
        'circle-radius': ['*', 18, ['get', 'shake']],
        'circle-color': RED,
        'circle-opacity': ['*', 0.35, ['get', 'shake']],
      },
    });
    map.addLayer({
      id: 'nodes',
      type: 'circle',
      source: 'nodes',
      paint: {
        'circle-radius': ['match', ['get', 'state'], 'trigger', 5, 'pick', 4.5, 'reject', 4.5, 3.5],
        'circle-color': ['match', ['get', 'state'], 'trigger', NODE_COLORS.trigger, 'pick', NODE_COLORS.pick, 'reject', NODE_COLORS.reject, 'offline', NODE_COLORS.offline, NODE_COLORS.idle],
        'circle-stroke-color': PAPER,
        'circle-stroke-width': 1.2,
      },
    });
    map.addLayer({
      id: 'events-halo',
      type: 'circle',
      source: 'events',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 4], 2, 12, 5, 20, 7.5, 32],
        'circle-color': RED,
        'circle-opacity': ['case', ['get', 'provisional'], 0.06, 0.14],
        'circle-stroke-color': RED,
        'circle-stroke-width': ['case', ['get', 'selected'], 2.5, 1.2],
      },
    });
    map.addLayer({
      id: 'events',
      type: 'circle',
      source: 'events',
      paint: {
        'circle-radius': ['case', ['get', 'provisional'], 7, 5],
        'circle-color': ['case', ['get', 'provisional'], PAPER, RED],
        'circle-stroke-color': ['case', ['get', 'provisional'], RED, PAPER],
        'circle-stroke-width': ['case', ['get', 'provisional'], 2.5, 2],
      },
    });
    map.addLayer({
      id: 'truth',
      type: 'circle',
      source: 'truth',
      paint: { 'circle-radius': 7, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': INK, 'circle-stroke-width': 2.5 },
    });
    // A dot is 7 px across: a press within a fingertip of it is a press on it.
    map.on('click', (e) => {
      const r = 10;
      const hits = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['nodes'] });
      const near = hits
        .map((f) => ({ id: String(f.properties?.id ?? ''), d: Math.hypot(...(['x', 'y'] as const).map((k) => map.project((f.geometry as GeoJSON.Point).coordinates as [number, number])[k] - e.point[k])) }))
        .filter((x) => x.id)
        .sort((a, b) => a.d - b.d)[0];
      if (near) this.showNode(near.id);
    });
    map.on('mouseenter', 'nodes', () => this.nodeInfo && (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nodes', () => this.nodeInfo && (map.getCanvas().style.cursor = ''));
    for (const [layer, kind] of [['events', 'event'], ['events-halo', 'event'], ['usgs', 'usgs']] as const) {
      map.on('click', layer, (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) this.onSelect(kind, String(id));
      });
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }
  }

  /** Empty every layer and forget the last screen's click handlers: each screen starts from a blank map. */
  clear() {
    this.nodesShown = [];
    this.nodeInfo = null;
    this.popup?.remove();
    this.popup = null;
    this.setPlaces([]);
    for (const id of SOURCES) this.set(id, fc([]));
    this.setRings([]);
    this.onSelect = () => {};
  }

  private set(id: Source, data: FC) {
    const src = this.map?.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(data);
    else this.pending.set(id, data);
  }

  private nodesShown: MapNode[] = [];
  setNodes(nodes: MapNode[]) {
    const was = this.nodesShown;
    if (nodes.length === was.length && nodes.every((n, i) => n.id === was[i].id && n.state === was[i].state && n.lat === was[i].lat && n.lon === was[i].lon && n.shake === was[i].shake)) return;
    this.nodesShown = nodes;
    this.set('nodes', fc(nodes.map((n) => pt(n, { id: n.id, state: n.state, shake: n.shake ?? 0 }))));
  }

  setEvents(events: MapEvent[]) {
    this.set('events', fc(events.map((e) => pt(e, { id: e.id, mag: e.mag, selected: !!e.selected, provisional: !!e.provisional }))));
    this.set(
      'links',
      fc(
        events
          .filter((e) => e.selected)
          .flatMap((e) => e.members.map((m) => feature({ type: 'LineString', coordinates: [at(e), at(m)] }))),
      ),
    );
  }

  setUsgs(q: MapQuake[]) {
    this.set('usgs', fc(q.map((x) => pt(x, { id: x.id, mag: x.mag, age: x.age }))));
  }

  setFelt(f: MapFelt[]) {
    this.set('felt', fc(f.map((x) => pt(x, { lvl: x.lvl }))));
  }

  setTrials(t: MapTrial[]) {
    this.set('trials', fc(t.map((x) => pt(x, { hit: x.hit }))));
  }

  setWaves(w: MapWaves | null) {
    this.set('waves', fc(w ? [ring(w.center, Math.max(w.pKm, 0.1), { phase: 'P' }), ring(w.center, Math.max(w.sKm, 0.1), { phase: 'S' })] : []));
  }

  setShake(cells: MapCell[]) {
    this.set('shake', fc(cells.map((c) => square(c, c.halfKm, { level: c.level }))));
  }

  private labels: Marker[] = [];
  private labelKey = '';
  setRings(rings: MapRing[]) {
    this.set('rings', fc(rings.map((r) => (r.kind === 'blind' ? disc(r.center, r.km, { kind: r.kind }) : ring(r.center, r.km, { kind: r.kind })))));
    const key = rings.map((r) => `${r.label}:${r.km.toFixed(1)}`).join('|');
    const { map, lib } = this;
    if (key === this.labelKey || !map || !lib) return;
    this.labelKey = key;
    this.labels.forEach((m) => m.remove());
    this.labels = rings
      .filter((r) => r.label)
      .map((r) => {
        const p = offset(r.center, 0, r.km);
        return new lib.Marker({ element: h('div', { class: `ring-label ${r.kind}` }, r.label!), anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
      });
  }

  private popup: Popup | null = null;
  /** Open the note for one phone beside its dot. */
  showNode(id: string) {
    const { map, lib } = this;
    const node = this.nodesShown.find((n) => n.id === id);
    const note = node && this.nodeInfo?.(id);
    if (!map || !lib || !node || !note) return;
    this.popup?.remove();
    this.popup = new lib.Popup({ closeButton: true, maxWidth: '240px', offset: 10, className: 'phone-popup' }).setLngLat([node.lon, node.lat]).setDOMContent(h('p', {}, note)).addTo(map);
  }

  private places: Marker[] = [];
  private placesKey = '';
  /** Name a few places on the map (a town beside the epicentre, the reader's own), drawn by Tremor so they show without the online basemap's labels. */
  setPlaces(list: { at: LatLon; text: string }[]) {
    const key = list.map((x) => `${x.text}@${x.at.lat},${x.at.lon}`).join('|');
    if (key === this.placesKey) return;
    this.placesKey = key;
    this.ready.then(() => {
      const { map, lib } = this;
      if (!map || !lib || key !== this.placesKey) return;
      this.places.forEach((m) => m.remove());
      this.places = list.map((x) => new lib.Marker({ element: h('div', { class: 'town-label' }, x.text), anchor: 'left' }).setLngLat([x.at.lon, x.at.lat]).addTo(map));
    });
  }

  setTruth(p: LatLon | null) {
    this.set('truth', fc(p ? [pt(p, {})] : []));
  }

  fly(center: LatLon, zoom: number) {
    this.ready.then(() => this.map?.flyTo({ center: [center.lon, center.lat], zoom, duration: 1400, essential: true }));
  }

  fitTo(points: LatLon[], maxZoom = 9) {
    if (!points.length) return;
    const lons = points.map((p) => p.lon);
    const lats = points.map((p) => p.lat);
    this.ready.then(() =>
      this.map?.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 60, maxZoom, duration: 1200 },
      ),
    );
  }

  resize() {
    this.map?.resize();
  }
}
