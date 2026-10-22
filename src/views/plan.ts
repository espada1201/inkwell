import type { LiveNetwork } from '../app/live';
import type { PlanMessage, PlanRequest } from '../app/planner.worker';
import { coarsen, distanceKm, offset, parseLatLon, type LatLon } from '../core/geo';
import { DISTURBED_PER_MINUTE, RELIABLY, enoughPhones, type PlanResult, type Summary } from '../core/planner';
import { sweepChart } from '../ui/chart';
import { h, keepFocus } from '../ui/dom';
import { coord, km, many, pct, secs } from '../ui/format';
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
/** "Here" plans for the phones within this distance of one spot: a saved location or typed coordinates. */
const HERE_KM = 20;
const SETTINGS = {
  under: { label: 'Directly beneath', words: 'beneath the city', km: [0, 10] },
  near: { label: 'Nearby fault', words: 'on a nearby fault', km: [15, 50] },
  far: { label: 'Far away', words: '60 to 150 km away', km: [60, 150] },
} as const;
type Setting = keyof typeof SETTINGS;
const SETTING_KEYS = Object.keys(SETTINGS) as Setting[];
const MAGS = [5, 6, 7];
const PHONES = [5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];
const SWEEP = [10, 25, 50, 100, 250, 500, 1000];
const QUAKES = 24;

/** A spot typed or linked as "lat, lon", snapped to the grid phones publish on; null unless both are in range. */
function parseSpot(text: string): LatLon | null {
  const at = parseLatLon(text);
  return at && coarsen(at);
}

export const PLAN_LEGEND: Swatch[] = [
  [NODE_COLORS.idle, 'phone (one simulation)'],
  ['var(--red)', 'simulated quake, detected'],
  ['transparent;border:1.5px solid var(--muted)', 'simulated quake, missed'],
];

export function planView(map: QuakeMap, arg: string | undefined, live: LiveNetwork, saved: LatLon | null) {
  const mine = saved && coarsen(saved);
  const isMine = (p: LatLon) => !!mine && mine.lat === p.lat && mine.lon === p.lon;
  const herePlace = (p: LatLon): City => ({
    id: `${p.lat},${p.lon}`,
    name: 'Here',
    ...p,
    radiusKm: HERE_KM,
    note: `Within ${HERE_KM} km of ${coord(p.lat, p.lon)}${isMine(p) ? ', your saved location' : ''}. Phones listening right now are counted from the relays this browser follows.`,
  });
  const [c, m, d, p] = (arg ?? '').split('/');
  const spot = parseSpot(c ?? '');
  const phones = Number(p);
  const state = {
    city: CITIES.find((x) => x.id === c) ?? (spot ? herePlace(spot) : CITIES[0]),
    mag: MAGS.includes(Number(m)) ? Number(m) : 6,
    // Not `in`: that would also accept inherited names like "toString".
    setting: SETTING_KEYS.find((k) => k === d) ?? 'near',
    // Any whole count the slider spans, so a link can carry the phones listening at a spot.
    phones: Number.isInteger(phones) && phones >= 1 && phones <= PHONES[PHONES.length - 1] ? phones : 200,
  };
  const here = () => !CITIES.includes(state.city);
  /** In Here, the plan runs at the phones listening right now until the reader picks a count. */
  let follow = false;
  const root = h('div', { class: 'panel-inner' });
  const cityButtons = h('div', { class: 'scenarios', role: 'group', 'aria-label': 'Place' });
  const cityNote = h('p', { class: 'small muted' });
  const spotInput = h('input', { 'aria-label': 'Latitude, longitude', placeholder: '37.77, -122.42', autocomplete: 'off', spellcheck: 'false', 'data-testid': 'here-spot' });
  const spotMsg = h('p', { class: 'small muted', role: 'status' });
  const hereForm = h(
    'form',
    {
      class: 'here-form',
      hidden: true,
      onsubmit: (e: Event) => {
        e.preventDefault();
        const at = parseSpot(spotInput.value);
        spotMsg.textContent = at ? '' : 'Type a latitude from −90 to 90 and a longitude from −180 to 180, like 37.77, -122.42.';
        if (at) goHere(at);
      },
    },
    spotInput,
    h('button', { class: 'btn', type: 'submit' }, 'Plan here'),
    spotMsg,
  );
  const gap = h('p', { class: 'plan-gap', 'aria-live': 'polite', 'data-testid': 'plan-gap', hidden: true });
  const magSeg = h('span', { class: 'seg', role: 'group', 'aria-label': 'Magnitude' });
  const settingSeg = h('span', { class: 'seg', role: 'group', 'aria-label': 'Where the quake strikes' });
  const slider = h('input', { type: 'range', min: 0, max: PHONES.length - 1, step: 1, class: 'scrub', 'aria-label': 'Phones listening', 'data-testid': 'phones' });
  const phonesOut = h('output', { class: 'mono big-num' });
  const status = h('p', { class: 'small mono muted', role: 'status', 'data-testid': 'plan-status' });
  const results = h('div', { class: 'plan-results', 'aria-live': 'polite' });
  const chart = h('div', {});
  let result: PlanResult | null = null;
  let points: Summary[] = [];
  let sweep = SWEEP;
  let jobId = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const worker = new Worker(new URL('../app/planner.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<PlanMessage>) => {
    const msg = e.data;
    if (msg.id !== jobId) return;
    if (msg.type === 'progress') {
      status.textContent = msg.phones === state.phones && !result ? `Simulating ${QUAKES} earthquakes on ${many(state.phones, 'phone')}… ${pct(msg.value)}` : `Drawing the curve: ${many(msg.phones, 'phone')}… ${pct(msg.value)}`;
    } else if (msg.type === 'result') {
      result = msg.result;
      status.textContent = 'Drawing the curve…';
      renderResults();
      syncMap();
    } else {
      points = [...points.filter((x) => x.phones !== msg.summary.phones), msg.summary];
      if (SWEEP.every((n) => points.some((x) => x.phones === n))) status.textContent = `Done: ${QUAKES} quakes and a busy hour per network size.`;
      renderChart();
      renderGap();
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
        sweep = SWEEP.includes(state.phones) ? SWEEP : [...SWEEP, state.phones].sort((a, b) => a - b);
        const req: PlanRequest = {
          id,
          input: { city: state.city, radiusKm: state.city.radiusKm, phones: state.phones, mag: state.mag, distanceKm: [...SETTINGS[state.setting].km], quakes: QUAKES },
          sweep,
        };
        worker.postMessage(req);
        status.textContent = `Simulating ${QUAKES} earthquakes on ${many(state.phones, 'phone')}…`;
        renderResults();
        renderChart();
        renderGap();
      },
      now ? 0 : 250,
    );
    history.replaceState(null, '', `#plan/${state.city.id}/${state.mag}/${state.setting}/${state.phones}`);
  }

  /** Phones heard from right now within the Here radius. */
  const listening = () => [...live.nodes.values()].filter((n) => live.isOnline(n) && distanceKm(n, state.city) <= HERE_KM).length;

  /** While following, take the phones listening now as the plan's count; true if it changed. */
  function adopt() {
    const n = listening();
    if (!follow || n === 0 || n === state.phones) return false;
    state.phones = n;
    return true;
  }

  function goHere(at: LatLon) {
    state.city = herePlace(at);
    follow = true;
    adopt();
    renderControls();
    frame();
    run(true);
  }

  /** Where the phones are and where the quakes strike, in words: a city by name, or a spot. */
  function words() {
    const { city, setting } = state;
    if (!here()) return { area: `across ${city.name}`, where: SETTINGS[setting].words };
    const who = isMine(city) ? 'you' : coord(city.lat, city.lon);
    return { area: `within ${HERE_KM} km of ${who}`, where: setting === 'under' ? `beneath ${who}` : SETTINGS[setting].words };
  }

  function renderControls() {
    cityButtons.replaceChildren(
      h(
        'button',
        {
          class: 'scenario',
          'aria-pressed': String(here()),
          'data-city': 'here',
          onclick: () => {
            if (mine) return goHere(mine);
            hereForm.hidden = false;
            spotMsg.textContent = 'Type coordinates, or save your location under Be a sensor.';
            spotInput.focus();
          },
        },
        h('b', {}, 'Here'),
        h('span', {}, mine ? `${HERE_KM * 2} km across` : 'type a spot'),
      ),
      ...CITIES.map((x) =>
        h(
          'button',
          {
            class: 'scenario',
            'aria-pressed': String(x.id === state.city.id),
            'data-city': x.id,
            onclick: () => {
              state.city = x;
              follow = false;
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
    if (here()) spotInput.value = `${state.city.lat}, ${state.city.lon}`;
    hereForm.hidden = !here();
    magSeg.replaceChildren(
      ...MAGS.map((v) => h('button', { 'aria-pressed': String(v === state.mag), onclick: () => ((state.mag = v), renderControls(), run(true)) }, `M${v}`)),
    );
    settingSeg.replaceChildren(
      ...SETTING_KEYS.map((k) =>
        h('button', { 'aria-pressed': String(k === state.setting), onclick: () => ((state.setting = k), renderControls(), frame(), run(true)) }, SETTINGS[k].label),
      ),
    );
    showPhones();
  }

  function showPhones() {
    // A count between the slider's steps (the phones listening at a spot) sits at the next step up.
    const i = PHONES.findIndex((v) => v >= state.phones);
    slider.value = String(i < 0 ? PHONES.length - 1 : i);
    phonesOut.textContent = many(state.phones, 'phone');
    slider.setAttribute('aria-valuetext', phonesOut.textContent);
  }

  slider.addEventListener('input', () => {
    state.phones = PHONES[Number(slider.value)];
    follow = false;
    showPhones();
    run();
  });

  /** Here only: the phones listening now beside the count that would catch the chosen quake, never one without the other. */
  function renderGap() {
    gap.hidden = !here();
    if (gap.hidden) return;
    const { area, where } = words();
    const quake = `an M${state.mag} ${where}`;
    const enough = enoughPhones(sweep, points);
    const n = listening();
    const now = `Right now ${n ? many(n, 'phone listens', 'phones listen') : 'no phones listen'} ${area}; `;
    let text = `Working out how many phones would catch ${quake}…`;
    let link: HTMLElement | null = null;
    if (enough) {
      text = `${now}about ${enough.phones} would catch ${quake} ${Math.round(RELIABLY * 10)} times in 10, alerting phones about ${secs(enough.medianAlertS)} after it begins.`;
      link = h(
        'a',
        {
          href: `#plan/${state.city.id}/${state.mag}/${state.setting}/${enough.phones}`,
          onclick: (e: Event) => {
            e.preventDefault();
            state.phones = enough.phones;
            follow = false;
            showPhones();
            run(true);
          },
        },
        `Plan with ${enough.phones} phones here`,
      );
    } else if (enough === null) {
      const most = points.find((s) => s.phones === sweep[sweep.length - 1])!;
      text = `${now}even ${most.phones} would catch only ${pct(most.detected)} of simulated M${state.mag} quakes ${where}.`;
    }
    if (gap.dataset.text === text) return;
    gap.dataset.text = text;
    keepFocus(gap, () => gap.replaceChildren(text, ...(link ? [' ', link] : [])));
  }

  const off = live.on(() => {
    if (!here()) return;
    if (adopt()) {
      showPhones();
      run();
    }
    renderGap();
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
    const { area, where } = words();
    const listeners = `${many(state.phones, 'phone')} listening ${area}`;
    const story =
      caught === 0
        ? `With ${listeners}, none of the ${n} simulated M${state.mag} quakes ${where} was detected: too few phones felt them strongly enough. Try more phones.`
        : `With ${listeners}, the network caught ${caught} of ${n} simulated M${state.mag} quakes ${where}, and its first alert typically reached phones ${s.medianAlertS!.toFixed(1)} s after they began. ` +
          (s.warned === null
            ? 'No part of the area would shake more than lightly, so there is nothing to warn about.'
            : s.warned > 0
              ? `Across the part of the area that shook at least moderately, ${pct(s.warned)} would have been alerted before the strong shaking arrived${s.medianWarningS !== null ? `, with a median of ${s.medianWarningS.toFixed(1)} s to drop, cover and hold on` : ''}.`
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
    h('div', {}, h('h1', {}, 'Plan a network'), h('p', { class: 'lede' }, 'How many phones does a city, or your own area, need? Pick a place and an earthquake. Tremor throws dozens of simulated quakes at simulated phones that behave like the real detector, through the same network code as the live map.')),
    h('section', { class: 'plan-controls' }, cityButtons, cityNote, hereForm, gap, h('div', { class: 'transport' }, magSeg, settingSeg), h('label', { class: 'phones' }, h('span', {}, 'Phones listening at the moment it strikes'), phonesOut), slider),
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
      off();
      clearTimeout(debounce);
      worker.terminate();
      map.setRings([]);
      map.setTrials([]);
    },
  };
}
