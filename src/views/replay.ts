import type { Replay } from '../app/replay';
import { shakeGrid, sRadiusKm } from '../core/impact';
import { ORIGIN_OFFSET_S, SCENARIOS, sinceOrigin, type Scenario } from '../core/scenarios';
import { usgsEventUrl } from '../net/usgs';
import { h } from '../ui/dom';
import { clockT } from '../ui/format';
import { NODE_COLORS, type MapRing, type QuakeMap, type Swatch } from '../ui/map';
import { drawSection } from '../ui/section';
import { compareCard } from './compare';

const ISOCHRONS = [5, 10, 20];

export const REPLAY_LEGEND: Swatch[] = [
  [NODE_COLORS.idle, 'phone'],
  [NODE_COLORS.pick, 'felt shaking, still checking'],
  [NODE_COLORS.trigger, 'confirmed shaking / Tremor epicentre'],
  [NODE_COLORS.reject, 'withdrawn by the phone'],
  ['transparent;border:2px solid var(--red)', 'provisional detection'],
  ['transparent;border:2px solid var(--ink)', 'USGS epicentre'],
  ['transparent;border:1.5px dashed var(--muted)', 'P and S wavefronts'],
];

export function replayView(r: Replay, map: QuakeMap, initial: string | undefined, speed: number) {
  const root = h('div', { class: 'panel-inner' });
  const canvas = h('canvas', { class: 'section', role: 'img', 'aria-label': 'Record section: phone traces sorted by distance from the epicentre' });
  const clock = h('span', { class: 'clock', 'data-testid': 'clock' });
  const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: 1000, value: 0, 'aria-label': 'Replay position' });
  const playBtn = h('button', { class: 'btn primary', 'data-testid': 'play' });
  const stats = h('p', { class: 'small mono muted', 'data-testid': 'replay-stats' });
  const steps = h('ol', { class: 'timeline', 'aria-label': 'What the network knew, and when' });
  // The cards redraw as the replay plays; screen readers hear only its milestones, through `said`.
  const warn = h('div', {});
  const result = h('div', {});
  const said = h('p', { class: 'sr-only', role: 'status', 'data-testid': 'replay-status' });
  const picker = h('div', { class: 'scenarios', role: 'group', 'aria-label': 'Scenarios' });
  const blurb = h('p', { class: 'lede' });
  r.speed = speed;

  playBtn.addEventListener('click', () => (r.playing ? r.pause() : r.play()));
  scrub.addEventListener('input', () => r.seek((Number(scrub.value) / 1000) * r.duration));
  const speeds = h(
    'span',
    { class: 'seg', role: 'group', 'aria-label': 'Playback speed' },
    ...[1, 4, 10].map((s) => h('button', { 'data-speed': s, 'aria-pressed': String(r.speed === s), onclick: () => ((r.speed = s), update()) }, `${s}×`)),
  );

  /** Fit the map to the loaded scenario's phones and epicentre. */
  function frame(s: Scenario) {
    const pts = r.nodes.map((n) => ({ lat: n.lat, lon: n.lon }));
    if (s.truth) pts.push(s.truth);
    map.fitTo(pts, 10);
  }

  function choose(s: Scenario) {
    r.load(s);
    history.replaceState(null, '', `#replay/${s.id}`);
    frame(s);
    blurb.textContent = s.blurb;
    renderPicker();
    lastKey = '';
    r.play();
  }

  function renderPicker() {
    picker.replaceChildren(
      ...SCENARIOS.map((s) =>
        h(
          'button',
          { class: 'scenario', 'aria-pressed': String(r.sim?.scenario.id === s.id), 'data-scenario': s.id, onclick: () => choose(s) },
          h('b', {}, s.title),
          h('span', {}, s.place),
        ),
      ),
    );
  }

  function timeline() {
    const sim = r.sim!;
    const truth = sim.scenario.truth;
    const rows: [string, number | null, string][] = [
      ['Rupture', truth ? ORIGIN_OFFSET_S * 1000 : null, truth ? `M${truth.mag.toFixed(1)}, ${truth.depthKm} km deep` : 'no earthquake in this scenario'],
      ['First phone picks', r.firstPickAt, truth ? 'first wave felt; sent within half a second, before any vetting' : 'a disturbance; sent within half a second, before any vetting'],
      ['Network declares', r.declared?.at ?? null, r.declared ? `${r.declared.event.triggers.length} phones agree and the quiet ones do not outvote them` : 'needs picks from 4 phones in 3 places that fit one wavefront'],
      ['Confirmed and sized', r.confirmedAt, r.events.length ? `${r.events[0].triggers.length} vetted triggers, magnitude from their peak shaking` : 'each phone checks its shaking for 15–30 s first'],
    ];
    steps.replaceChildren(
      ...rows.map(([label, at, note]) =>
        h(
          'li',
          { class: at !== null && at <= r.vt ? 'done' : '' },
          h('span', { class: 'when mono' }, at !== null && at <= r.vt ? clockT(sinceOrigin(at)) : '—'),
          h('b', {}, label),
          h('span', { class: 'note' }, note),
        ),
      ),
    );
  }

  function warningCard() {
    const sim = r.sim!;
    const w = r.warning();
    if (!sim.scenario.truth) {
      const rej = [...r.counts().withdrawn.values()].reduce((a, b) => a + b, 0);
      return h(
        'section',
        { class: 'warn-card calm', 'data-testid': 'warning' },
        h('b', {}, r.declared ? 'False alert' : 'No alert'),
        h(
          'p',
          {},
          r.declared
            ? 'The network declared a quake that did not happen. This is the failure mode early warning has to keep rare.'
            : `${rej} local disturbances were caught and withdrawn by the phones themselves; the picks never lined up into a wavefront the quiet phones could agree with.`,
        ),
      );
    }
    if (!w) return h('section', { class: 'warn-card pending', 'data-testid': 'warning' }, h('b', {}, 'Early warning'), h('p', {}, 'Waiting for enough phones to feel the first waves…'));
    const felt = w.warnings.length;
    const sorted = [...w.warnings].sort((a, b) => b - a);
    const max = Math.max(1, ...sorted.map((x) => Math.abs(x)));
    return h(
      'section',
      { class: 'warn-card', 'data-testid': 'warning' },
      h(
        'header',
        {},
        h('b', {}, 'Early warning, had it been live'),
        h('span', { class: 'mono' }, `alert ${clockT(w.alertAt)}`),
      ),
      h(
        'p',
        { class: 'big' },
        h('span', { class: 'mono', 'data-testid': 'warned' }, `${w.warned}/${felt}`),
        ' phones that felt it would have been warned before the strong shaking',
        w.median !== null ? h('span', {}, ` (median ${w.median.toFixed(1)} s, up to ${sorted[0].toFixed(1)} s)`) : null,
        '.',
      ),
      h(
        'div',
        { class: 'bars', role: 'img', 'aria-label': 'Warning time per phone, longest first' },
        ...sorted.map((x) => h('i', { class: x > 0 ? 'pos' : 'neg', style: `height:${Math.max(2, (Math.abs(x) / max) * 100)}%` })),
      ),
      h(
        'p',
        { class: 'small muted' },
        `Inside ${w.blindKm.toFixed(0)} km the shaking beat the alert (the blind zone). Five seconds is enough to drop, cover and hold on, or to stop a train and open fire-station doors.`,
      ),
    );
  }

  /** The one line screen readers hear: the latest milestone the replay has passed. */
  function milestone() {
    const at = (ms: number) => clockT(sinceOrigin(ms));
    if (r.vt >= r.duration)
      return r.declared ? `Replay finished: declared at ${at(r.declared.at)}${r.confirmedAt !== null ? `, confirmed at ${at(r.confirmedAt)}` : ''}.` : 'Replay finished: no quake declared.';
    if (r.confirmedAt !== null) return `Confirmed at ${at(r.confirmedAt)}.`;
    return r.declared ? `Network declares a quake at ${at(r.declared.at)}.` : '';
  }

  let lastKey = '';
  let lastHeavy = 0;
  function update() {
    const sim = r.sim;
    if (!sim) return;
    const t = r.sinceOrigin;
    const m = milestone();
    if (said.textContent !== m) said.textContent = m;
    clock.textContent = clockT(t);
    scrub.value = String(Math.round((r.vt / r.duration) * 1000));
    scrub.setAttribute('aria-valuetext', `${Math.abs(t).toFixed(0)} seconds ${t < 0 ? 'before' : 'after'} the quake began`);
    playBtn.textContent = r.playing ? 'Pause' : r.vt >= r.duration ? 'Replay' : 'Play';
    speeds.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === r.speed)));

    // Map and canvas are the expensive part: ~15 fps is plenty.
    const now = performance.now();
    if (r.playing && now - lastHeavy < 66) return;
    lastHeavy = now;

    const { confirmed: trig, withdrawn } = r.counts();
    const rej = [...withdrawn.values()].reduce((a, b) => a + b, 0);
    stats.textContent = `${r.nodes.length} phones · ${trig} confirmed · ${rej} false alarms caught on-device`;
    map.setNodes(r.nodes.map((n) => ({ id: n.id, lat: n.lat, lon: n.lon, state: r.nodeState(n), shake: r.shake(n) })));
    map.setWaves(r.waves());
    const truth = sim.scenario.truth;
    map.setTruth(truth && t > 0 ? truth : null);
    map.setEvents([
      ...r.events.map((e) => ({ id: e.id, lat: e.lat, lon: e.lon, mag: e.mag, selected: true, members: e.triggers })),
      ...(r.early && !r.events.length ? [{ id: 'early', lat: r.early.lat, lon: r.early.lon, mag: null, provisional: true, members: r.early.triggers }] : []),
    ]);
    const w = r.warning();
    const rings: MapRing[] =
      w && truth && r.vt >= r.declared!.at
        ? [
            { center: truth, km: w.blindKm, kind: 'blind', label: 'blind zone' },
            ...ISOCHRONS.map((s) => ({ center: truth, km: sRadiusKm(w.alertAt + s, truth.depthKm), kind: 'iso' as const, label: `${s} s warning` })),
          ]
        : [];
    map.setRings(rings);
    drawSection(canvas, r);

    const key = `${r.events.length}|${r.declared?.at}|${trig}|${r.vt >= r.duration}|${r.playing}|${Math.floor(r.vt / 1000)}`;
    if (key === lastKey) return;
    lastKey = key;
    map.setShake(r.events.length ? shakeGrid(r.events[0].triggers) : []);
    timeline();
    warn.replaceChildren(warningCard());
    const ev = r.events[0];
    result.replaceChildren(
      ev
        ? compareCard(
            'Tremor located it',
            ev,
            truth ? { lat: truth.lat, lon: truth.lon, time: sim.origin, mag: truth.mag, label: 'USGS catalogue', url: truth.usgsId ? usgsEventUrl(truth.usgsId) : undefined } : null,
            'No real earthquake in this scenario, so this would be a false alarm.',
          )
        : '',
    );
  }

  root.append(
    h('div', {}, h('h1', {}, 'Replay'), h('p', { class: 'lede' }, 'Real historical quakes, played into a simulated network of phones. Every trace runs through the same detector your phone would, and every alert through the same network logic.')),
    picker,
    blurb,
    said,
    h('div', { class: 'transport' }, playBtn, clock, speeds),
    scrub,
    steps,
    warn,
    result,
    h(
      'section',
      {},
      h('h2', {}, 'Record section', h('small', {}, 'distance vs time')),
      canvas,
      h(
        'div',
        { class: 'legend-inline' },
        h('span', {}, h('i', { style: 'background:var(--ink)' }), 'P wave · phones that felt it first'),
        h('span', {}, h('i', { style: 'background:var(--red)' }), 'S wave · phones that felt it first'),
        h('span', {}, h('i', { style: 'background:var(--amber)' }), 'withdrawn by the phone'),
      ),
      stats,
    ),
  );
  map.clear();
  renderPicker();
  const off = r.on(update);
  const start = SCENARIOS.find((s) => s.id === initial) ?? SCENARIOS[0];
  if (r.sim?.scenario.id !== start.id) choose(start);
  else {
    // Back on the scenario already loaded: pick up where it was.
    frame(start);
    blurb.textContent = start.blurb;
    update();
  }
  const onResize = () => drawSection(canvas, r);
  window.addEventListener('resize', onResize);
  return {
    el: root,
    dispose: () => {
      off();
      r.pause();
      map.setRings([]);
      map.setShake([]);
      window.removeEventListener('resize', onResize);
    },
  };
}
