import { Map as MlMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { offset, type LatLon } from '../core/geo';

setWorkerUrl(workerUrl);

export const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/positron';

export interface MapNode extends LatLon {
  id: string;
  /** pick: felt shaking, still checking; trigger: confirmed; reject: withdrawn by the phone. */
  state: 'idle' | 'pick' | 'trigger' | 'reject' | 'offline';
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
  kind: 'blind' | 'iso';
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
const fc = (features: GeoJSON.Feature[]): FC => ({ type: 'FeatureCollection', features });
const pt = (p: LatLon, props: Record<string, unknown>): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
});
function circle(c: LatLon, km: number) {
  return Array.from({ length: 97 }, (_, i) => {
    const a = (i / 96) * 2 * Math.PI;
    const p = offset(c, km * Math.cos(a), km * Math.sin(a));
    return [p.lon, p.lat];
  });
}
const ring = (c: LatLon, km: number, props: Record<string, unknown>): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'LineString', coordinates: circle(c, km) },
});
const disc = (c: LatLon, km: number, props: Record<string, unknown>): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Polygon', coordinates: [circle(c, km)] },
});
function square(c: LatLon, halfKm: number, props: Record<string, unknown>): GeoJSON.Feature {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ].map(([e, n]) => {
    const p = offset(c, e * halfKm, n * halfKm);
    return [p.lon, p.lat];
  });
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [corners] } };
}

/** Intensity colours, weak → severe (index = intensity level). */
export const SHAKE_COLORS = ['rgba(0,0,0,0)', '#f3e7c4', '#efcf8e', '#e7a65e', '#d9773f', '#c4482a', '#94241a'];

const INK = '#1d1c1a';
const RED = '#c8261c';
const AMBER = '#a56a12';
const PAPER = '#f4f1e8';
const MUTED = '#6b675d';

/** Minimal offline basemap: Natural Earth land, loaded only if the online style is unreachable. */
async function fallbackStyle(): Promise<StyleSpecification> {
  const [{ feature }, land] = await Promise.all([import('topojson-client'), import('world-atlas/land-50m.json')]);
  const topo = (land as { default?: unknown }).default ?? land;
  const geo = feature(topo as any, (topo as any).objects.land) as unknown as GeoJSON.FeatureCollection;
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
  private pending = new Map<string, FC>();

  constructor(container: HTMLElement, view: { center: LatLon; zoom: number }) {
    this.ready = pickStyle().then(({ style, offline }) => {
      this.offline = offline;
      let map: MlMap;
      try {
        map = new MlMap({
        container,
        style,
        center: [view.center.lon, view.center.lat],
        zoom: view.zoom,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
      } catch {
        // No WebGL (very old device or locked-down browser): the lists still work.
        const note = document.createElement('div');
        note.className = 'map-error';
        note.textContent = 'The map needs WebGL, which this browser could not start. Everything else still works.';
        container.append(note);
        return;
      }
      // Tile hiccups are routine on flaky networks; they should not surface as page errors.
      map.on('error', (e) => console.warn('map:', e.error?.message ?? e));
      map.touchZoomRotate.disableRotation();
      map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
      this.map = map;
      return new Promise<void>((resolve) => {
        map.once('load', () => {
          this.addLayers(map);
          for (const [id, data] of this.pending) (map.getSource(id) as GeoJSONSource).setData(data);
          this.pending.clear();
          resolve();
        });
      });
    });
  }

  private addLayers(map: MlMap) {
    for (const id of ['shake', 'rings', 'waves', 'links', 'usgs', 'trials', 'nodes', 'events', 'truth']) map.addSource(id, { type: 'geojson', data: fc([]) });
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
        'circle-color': ['match', ['get', 'state'], 'trigger', RED, 'pick', '#e58a7c', 'reject', AMBER, 'offline', '#a19d92', INK],
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
    for (const [layer, kind] of [['events', 'event'], ['events-halo', 'event'], ['usgs', 'usgs']] as const) {
      map.on('click', layer, (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) this.onSelect(kind, String(id));
      });
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }
  }

  private set(id: string, data: FC) {
    const src = this.map?.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData(data);
    else this.pending.set(id, data);
  }

  setNodes(nodes: MapNode[]) {
    this.set('nodes', fc(nodes.map((n) => pt(n, { id: n.id, state: n.state, shake: n.shake ?? 0 }))));
  }

  setEvents(events: MapEvent[]) {
    this.set('events', fc(events.map((e) => pt(e, { id: e.id, mag: e.mag, selected: !!e.selected, provisional: !!e.provisional }))));
    this.set(
      'links',
      fc(
        events
          .filter((e) => e.selected)
          .flatMap((e) =>
            e.members.map((m) => ({
              type: 'Feature' as const,
              properties: {},
              geometry: { type: 'LineString' as const, coordinates: [[e.lon, e.lat], [m.lon, m.lat]] },
            })),
          ),
      ),
    );
  }

  setUsgs(q: MapQuake[]) {
    this.set('usgs', fc(q.map((x) => pt(x, { id: x.id, mag: x.mag, age: x.age }))));
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
    if (key === this.labelKey || !this.map) return;
    this.labelKey = key;
    this.labels.forEach((m) => m.remove());
    this.labels = rings
      .filter((r) => r.label)
      .map((r) => {
        const el = document.createElement('div');
        el.className = `ring-label ${r.kind}`;
        el.textContent = r.label!;
        const p = offset(r.center, 0, r.km);
        return new Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(this.map!);
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
