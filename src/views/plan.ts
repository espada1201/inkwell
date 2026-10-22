import type { PlanMessage, PlanRequest } from '../app/planner.worker';
import { offset, type LatLon } from '../core/geo';
import { DISTURBED_PER_MINUTE, type PlanResult, type Summary } from '../core/planner';
import { sweepChart } from '../ui/chart';
import { h } from '../ui/dom';
import { km, pct, secs } from '../ui/format';
import { NODE_COLORS, type QuakeMap, type Swatch } from '../ui/map';

interface City extends LatLon {
  id: string;
  name: string;
  radiusKm: number;
  note: string;
}

const CITIES: City[] = [
  { id: 'istanbul', name: 'Istanbul', lat: 41.03, lon: 28.98, radiusKm: 25, note: 'The North Anatolian Fault runs under the Sea of Marmara, just offshore.' },
  { id: 'kathmandu', name: 'Kathmandu', lat: 27.7, lon: 85.32, radiusKm: 10, note: 'The Gorkha earthquake, M7.8, struck Nepal in April 2015.' },
  { id: 'lima', name: 'Lima', lat: -12.06, lon: -77.04, radiusKm: 20, note: 'The Nazca plate dives under South America just off the coast.' },
  { id: 'manila', name: 'Manila', lat: 14.6, lon: 120.98, radiusKm: 18, note: 'The West Valley Fault runs through the metro area.' },
  { id: 'mexico-city', name: 'Mexico City', lat: 19.43, lon: -99.13, radiusKm: 25, note: 'An M7.1 earthquake shook the city in September 2017.' },
  { id: 'bay-area', name: 'San Francisco Bay', lat: 37.8, lon: -122.27, radiusKm: 25, note: 'The Hayward Fault runs under the East Bay.' },
];
const SETTINGS = {
  under: { label: 'Beneath the city', words: 'beneath the city', km: [0, 10] },
  near: { label: 'Nearby fault', words: 'on a nearby fault', km: [15, 50] },
  far: { label: 'Far away', words: '60 to 150 km away', km: [60, 150] },
} as const;
type Setting = keyof typeof SETTINGS;
const SETTING_KEYS = Object.keys(SETTINGS) as Setting[];
const MAGS = [5, 6, 7];
const PHONES = [5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];
const SWEEP = [10, 25, 50, 100, 250, 500, 1000];
const QUAKES = 24;


export const PLAN_LEGEND: Swatch[] = [
  [NODE_COLORS.idle, 'phone (one simulation)'],
  ['var(--red)', 'simulated quake, detected'],
  ['transparent;border:1.5px solid var(--muted)', 'simulated quake, missed'],
];

export function planView(map: QuakeMap, arg: string | undefined) {
  const [c, m, d, p] = (arg ?? '').split('/');
  const state = {
    city: CITIES.find((x) => x.id === c) ?? CITIES[0],
    mag: MAGS.includes(Number(m)) ? Number(m) : 6,
    // Not `in`: that would also accept inherited names like "toString".
    setting: SETTING_KEYS.find((k) => k === d) ?? 'near',
    phones: PHONES.includes(Number(p)) ? Number(p) : 200,
  };
  const root = h('div', { class: 'panel-inner' });
  const cityButtons = h('div', { class: 'scenarios', role: 'group', 'aria-label': 'City' });
  const cityNote = h('p', { class: 'small muted' });
  const magSeg = h('span', { class: 'seg', role: 'group', 'aria-label': 'Magnitude' });
  const settingSeg = h('span', { class: 'seg', role: 'group', 'aria-label': 'Where the quake strikes' });
  const slider = h('input', { type: 'range', min: 0, max: PHONES.length - 1, step: 1, class: 'scrub', 'aria-label': 'Phones listening', 'data-testid': 'phones' });
  const phonesOut = h('output', { class: 'mono big-num' });
  const status = h('p', { class: 'small mono muted', role: 'status', 'data-testid': 'plan-status' });
  const results = h('div', { class: 'plan-results', 'aria-live': 'polite' });
  const chart = h('div', {});
  let result: PlanResult | null = null;
  let points: Summary[] = [];
  let jobId = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const worker = new Worker(new URL('../app/planner.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<PlanMessage>) => {
    const msg = e.data;
    if (msg.id !== jobId) return;
    if (msg.type === 'progress') {
      status.textContent = msg.phones === state.phones && !result ? `Simulating ${QUAKES} earthquakes on ${state.phones} phones… ${pct(msg.value)}` : `Drawing the curve: ${msg.phones} phones… ${pct(msg.value)}`;
    } else if (msg.type === 'result') {
      result = msg.result;
      status.textContent = 'Drawing the curve…';
      renderResults();
      syncMap();
    } else {
      points = [...points.filter((x) => x.phones !== msg.summary.phones), msg.summary];
      if (SWEEP.every((n) => points.some((x) => x.phones === n))) status.textContent = `Done: ${QUAKES} quakes and a busy hour per network size.`;
      renderChart();
    }
  };
  worker.onerror = () => (status.textContent = 'The planner stopped unexpectedly. Reload the page to try again.');

  function run(now = false) {
    clearTimeout(debounce);
    debounce = setTimeout(
      () => {
        const id = ++jobId;
        result = null;
        points = [];
        const req: PlanRequest = {
          id,
          input: { city: state.city, radiusKm: state.city.radiusKm, phones: state.phones, mag: state.mag, distanceKm: [...SETTINGS[state.setting].km], quakes: QUAKES },
          sweep: SWEEP.includes(state.phones) ? SWEEP : [...SWEEP, state.phones].sort((a, b) => a - b),
        };
        worker.postMessage(req);
        status.textContent = `Simulating ${QUAKES} earthquakes on ${state.phones} phones…`;
        renderResults();
        renderChart();
      },
      now ? 0 : 250,
    );
    history.replaceState(null, '', `#plan/${state.city.id}/${state.mag}/${state.setting}/${state.phones}`);
  }

  function renderControls() {
    cityButtons.replaceChildren(
      ...CITIES.map((x) =>
        h(
          'button',
          {
            class: 'scenario',
            'aria-pressed': String(x.id === state.city.id),
            'data-city': x.id,
            onclick: () => {
              state.city = x;
              renderControls();
              frame();
              run(true);
            },
          },
          h('b', {}, x.name),
          h('span', {}, `${x.radiusKm * 2} km across`),
        ),
      ),
    );
    cityNote.textContent = state.city.note;
    magSeg.replaceChildren(
      ...MAGS.map((v) => h('button', { 'aria-pressed': String(v === state.mag), onclick: () => ((state.mag = v), renderControls(), run(true)) }, `M${v}`)),
    );
    settingSeg.replaceChildren(
      ...SETTING_KEYS.map((k) =>
        h('button', { 'aria-pressed': String(k === state.setting), onclick: () => ((state.setting = k), renderControls(), frame(), run(true)) }, SETTINGS[k].label),
      ),
    );
    slider.value = String(PHONES.indexOf(state.phones));
    showPhones();
  }

  function showPhones() {
    phonesOut.textContent = `${state.phones} phones`;
    slider.setAttribute('aria-valuetext', phonesOut.textContent);
  }

  slider.addEventListener('input', () => {
    state.phones = PHONES[Number(slider.value)];
    showPhones();
    run();
  });

  function tile(label: string, value: string, sub: string, testid?: string) {
    return h('div', {}, h('span', {}, label), h('b', { 'data-testid': testid ?? null }, value), h('small', {}, sub));
  }

  function renderResults() {
    if (!result) {
      results.replaceChildren(h('div', { class: 'kpis pending' }, ...['Detected', 'First alert', 'Warned in time', 'Warning', 'Located within', 'False alerts'].map((l) => tile(l, '…', ' '))));
      return;
    }
    const s = result.summary;
    const n = result.trials.length;
    const caught = Math.round(s.detected * n);
    const where = SETTINGS[state.setting].words;
    const story =
      caught === 0
        ? `With ${state.phones} phones listening across ${state.city.name}, none of the ${n} simulated M${state.mag} quakes ${where} was detected: too few phones felt them strongly enough. Try more phones.`
        : `With ${state.phones} phones listening across ${state.city.name}, the network caught ${caught} of ${n} simulated M${state.mag} quakes ${where}, and its first alert typically reached phones ${s.medianAlertS!.toFixed(1)} s after they began. ` +
          (s.warned === null
            ? 'No part of the city would shake more than lightly, so there is nothing to warn about.'
            : s.warned > 0
              ? `Across the part of the city that shook at least moderately, ${pct(s.warned)} would have been alerted before the strong shaking arrived${s.medianWarningS !== null ? `, with a median of ${s.medianWarningS.toFixed(1)} s to drop, cover and hold on` : ''}.`
              : 'The strong shaking reached everyone before any alert could: this is the blind zone every warning system has close to the epicentre.');
    results.replaceChildren(
      h(
        'div',
        { class: 'kpis', 'data-testid': 'kpis' },
        tile('Detected', `${caught}/${n}`, 'simulated quakes', 'kpi-detected'),
        tile('First alert', secs(s.medianAlertS), 'at the phones, after the rupture', 'kpi-alert'),
        tile('Warned in time', pct(s.warned), 'of the shaken area', 'kpi-warned'),
        tile('Warning', secs(s.medianWarningS), 'median, if warned'),
        tile('Located within', km(s.medianErrKm), 'median, once confirmed'),
        tile('False alerts', `${s.falseAlerts}/${s.quietMinutes}`, 'busy minutes, no quake', 'kpi-false'),
      ),
      h('p', { class: 'plan-story' }, story),
    );
  }

  function renderChart() {
    chart.replaceChildren(
      h('h2', {}, 'How many phones are enough?', h('small', {}, `M${state.mag} · ${SETTINGS[state.setting].label.toLowerCase()}`)),
      points.length ? sweepChart(SWEEP, points, state.phones) : h('div', { class: 'skeleton chart-skeleton' }),
    );
  }

  function frame() {
    const far = Math.max(state.city.radiusKm, SETTINGS[state.setting].km[1]);
    map.fitTo([offset(state.city, -far, -far), offset(state.city, far, far)], 10);
  }

  function syncMap() {
    map.setRings([{ center: state.city, km: state.city.radiusKm, kind: 'iso', label: state.city.name }]);
    map.setNodes((result?.phones ?? []).map((q, i) => ({ id: `p${i}`, ...q, state: 'idle' })));
    map.setTrials((result?.trials ?? []).map((t) => ({ ...t.epicentre, hit: t.declaredS !== null })));
  }

  map.clear();
  root.append(
    h('div', {}, h('h1', {}, 'Plan a network'), h('p', { class: 'lede' }, 'How many phones does a city need? Pick a place and an earthquake. Tremor throws dozens of simulated quakes at simulated phones that behave like the real detector, through the same network code as the live map.')),
    h('section', { class: 'plan-controls' }, cityButtons, cityNote, h('div', { class: 'transport' }, magSeg, settingSeg), h('label', { class: 'phones' }, h('span', {}, 'Phones listening at the moment it strikes'), phonesOut), slider),
    status,
    results,
    h('section', {}, chart),
    h(
      'p',
      { class: 'honest' },
      `Each simulated phone behaves the way the real on-device detector did on synthetic recordings. The ground is uniform, shaking follows one generic attenuation curve, phones lie flat, 1 in ${Math.round(1 / DISTURBED_PER_MINUTE)} gets bumped each minute, and messages take a second each way through the relays. Real faults, soils and buildings are not modelled, so read the numbers as a guide to scale, not a forecast.`,
    ),
  );
  renderControls();
  frame();
  run(true);
  return {
    el: root,
    dispose: () => {
      clearTimeout(debounce);
      worker.terminate();
      map.setRings([]);
      map.setTrials([]);
    },
  };
}
