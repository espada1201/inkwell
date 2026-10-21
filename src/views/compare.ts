import { distanceKm } from '../core/geo';
import { h, mag, utc } from '../ui/dom';

const ll = (lat: number, lon: number) => [
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`,
  h('br'),
  `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`,
];

export interface Estimate {
  lat: number;
  lon: number;
  time: number;
  mag: number | null;
  nodes: number;
  rms: number;
}
export interface Reference {
  lat: number;
  lon: number;
  time: number;
  mag: number | null;
  label: string;
  url?: string;
}

/** Side-by-side: what the phones worked out vs what the official network says. */
export function compareCard(title: string, est: Estimate, ref: Reference | null, refMissing: string) {
  const d = ref ? distanceKm(est, ref) : null;
  const dt = ref ? (est.time - ref.time) / 1000 : null;
  const dm = ref && est.mag !== null && ref.mag !== null ? est.mag - ref.mag : null;
  const verdict =
    d === null
      ? refMissing
      : `Off by ${d.toFixed(1)} km and ${Math.abs(dt!).toFixed(1)} s${dm !== null ? `, magnitude ${dm >= 0 ? '+' : '−'}${Math.abs(dm).toFixed(1)}` : ''}.`;
  return h(
    'section',
    { class: 'compare', 'aria-label': title, 'data-testid': 'compare' },
    h('header', {}, h('b', {}, title), h('span', { class: 'mono small muted' }, `${est.nodes} phones · rms ${est.rms.toFixed(2)} s`)),
    h(
      'table',
      {},
      h('tr', {}, h('th', {}, ''), h('th', {}, 'Tremor (phones)'), h('th', {}, ref ? ref.label : 'Official')),
      h('tr', {}, h('td', {}, 'Epicentre'), h('td', { class: 'num', 'data-testid': 'est-loc', 'data-lat': est.lat.toFixed(3), 'data-lon': est.lon.toFixed(3) }, ...ll(est.lat, est.lon)), h('td', { class: 'num' }, ...(ref ? ll(ref.lat, ref.lon) : ['—']))),
      h('tr', {}, h('td', {}, 'Origin'), h('td', { class: 'num' }, utc(est.time).slice(11)), h('td', { class: 'num' }, ref ? utc(ref.time).slice(11) : '—')),
      h('tr', {}, h('td', {}, 'Magnitude'), h('td', { class: 'num' }, `${mag(est.mag)} (rough)`), h('td', { class: 'num' }, ref ? mag(ref.mag) : '—')),
    ),
    h('p', { class: 'verdict', 'data-testid': 'verdict' }, verdict, ref?.url ? ' ' : null, ref?.url ? h('a', { href: ref.url, target: '_blank', rel: 'noopener' }, 'USGS page ↗') : null),
  );
}
