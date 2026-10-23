import type { LiveNetwork } from '../app/live';
import type { Replay } from '../app/replay';
import { eventUncertainty } from '../core/associate';
import { distanceKm, type LatLon } from '../core/geo';
import { shakeGrid, sRadiusKm, warningNear } from '../core/impact';
import { epicentreTown, type Town } from '../core/places';
import { MIN_REPLAY_MAG, ORIGIN_OFFSET_S, SCENARIOS, parseQuakeLink, quakeLink, type QuakeRef, type Scenario } from '../core/scenarios';
import { usgsEventUrl } from '../net/usgs';
import { h, keepFocus } from '../ui/dom';
import { WITHDRAWN, ago, clockT, coord, mag, many, utc } from '../ui/format';
import { NODE_COLORS, type MapRing, type QuakeMap, type Swatch } from '../ui/map';
import { drawSection } from '../ui/section';
import { nearLine, phoneNote } from '../ui/warnnear';
import { compareCard, give } from './compare';
import { loadTowns } from './place';

const ISOCHRONS = [5, 10, 20];
const elapsed = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const NEAR_HOME_KM = 150;
const RECENT = 5;
/** Phones this close to a place stand for it: a town is some 10 km across. */
const NEAR_PLACE_KM = 15;

export const REPLAY_LEGEND: Swatch[] = [
  [NODE_COLORS.idle, 'simulated phone'],
  [NODE_COLORS.pick, 'felt shaking, still checking'],
  [NODE_COLORS.trigger, 'confirmed shaking / Tremor epicentre'],
  [NODE_COLORS.reject, 'withdrawn by the phone'],
  ['transparent;border:2px solid var(--red)', 'provisional detection'],
  ['transparent;border:2px solid var(--ink)', 'USGS epicentre'],
  ['transparent;border:1px dashed var(--ink)', 'where a detection could be'],
  ['transparent;border:1.5px dashed var(--muted)', 'P and S wavefronts'],
  ['rgba(200,38,28,.14);border:1.5px dashed var(--red)', 'blind zone: the strong shaking got there before the alert'],
  ['transparent;border:1px dashed var(--ink)', '5, 10 and 20 s rings: the strong shaking reaches a ring that many seconds after the alert'],
];

export function replayView(r: Replay, map: QuakeMap, initial: string | undefined, speed: number, live: LiveNetwork, saved: LatLon | null, savedName: string | null = null) {
  const root = h('div', { class: 'panel-inner' });
  const canvas = h('canvas', { class: 'section', role: 'img', 'aria-label': 'Record section: phone traces sorted by distance from the epicentre' });
  const clock = h('span', { class: 'clock', 'data-testid': 'clock' });
  const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: 1000, value: 0, 'aria-label': 'Replay position' });
  const playBtn = h('button', { class: 'btn primary', 'data-testid': 'play' });
  const stats = h('p', { class: 'small mono muted', 'data-testid': 'replay-stats' });
  const steps = h('ol', { class: 'timeline', 'aria-label': 'What the network knew, and when' });
  const warn = h('div', {});
  const phones = h('div', {});
  const result = h('div', {});
  const said = h('p', { class: 'sr-only', role: 'status', 'data-testid': 'replay-status' });
  const picker = h('div', { class: 'scenarios', role: 'group', 'aria-label': 'Scenarios' });
  const recent = h('ul', { class: 'recent', 'aria-label': 'Recent quakes from the USGS feed', 'data-testid': 'recent' });
  const blurb = h('p', { class: 'lede' });
  const caption = h('p', { class: 'small muted' });
  r.speed = speed;

  playBtn.addEventListener('click', () => (r.playing ? r.pause() : r.play()));
  scrub.addEventListener('input', () => r.seek((Number(scrub.value) / 1000) * r.duration));
  const speeds = h(
    'span',
    { class: 'seg', role: 'group', 'aria-label': 'Playback speed' },
    ...[1, 4, 10].map((s) => h('button', { 'data-speed': s, 'aria-pressed': String(r.speed === s), onclick: () => ((r.speed = s), update()) }, `${s}×`)),
  );

  const clockText = (at: number) => (r.sim?.scenario.truth ? clockT(r.clockAt(at)) : elapsed(r.clockAt(at)));

  /** Fit the map to the loaded scenario's phones and epicentre. */
  function frame(s: Scenario) {
    const pts = r.nodes.map((n) => ({ lat: n.lat, lon: n.lon }));
    if (s.truth) pts.push(s.truth);
    map.fitTo(pts, 10);
  }

  /** The town the quake is named for, and where the reader is, once the list of towns has loaded. */
  let named: { id: string; town: Town | null } | null = null;
  let gone = false;
  const inArea = (p: LatLon) => r.nodes.some((n) => distanceKm(n, p) <= NEAR_PLACE_KM);
  const here = (town: Town | null) => !!saved && inArea(saved) && !(town && distanceKm(saved, town) <= 5);

  function nameQuake(s: Scenario) {
    named = null;
    map.setPlaces([]);
    const truth = s.truth;
    if (!truth) return;
    loadTowns()
      .then((towns) => epicentreTown(towns, truth), () => null)
      .then((town) => {
        if (gone || r.sim?.scenario.id !== s.id) return;
        named = { id: s.id, town };
        map.setPlaces([
          ...(town ? [{ at: town, text: town.name }] : []),
          ...(saved && here(town) ? [{ at: saved, text: `${(savedName ?? 'You').split(',')[0]} (you)` }] : []),
        ]);
        lastKey = '';
        update();
      });
  }

  function quakeScenario(q: QuakeRef): Scenario {
    const home = saved && distanceKm(saved, q) <= NEAR_HOME_KM ? saved : null;
    const where = live.usgs.find((x) => x.id === q.id)?.place ?? coord(q.lat, q.lon);
    // shortcut: every replayed quake gets 40 phones within 30 km, not the density of real phones there; derive it from Tremor's own network once it has one.
    return {
      id: quakeLink(q),
      title: mag(q.mag),
      place: where,
      blurb: `${mag(q.mag)}, ${where}, ${utc(q.time)}, from the USGS feed. The quake is real; the phones are simulated, around ${home ? 'your saved location' : 'the epicentre'}. This page's address replays it, even after it leaves the feed.`,
      truth: { lat: q.lat, lon: q.lon, depthKm: q.depthKm, mag: q.mag, usgsId: q.id, date: new Date(q.time).toISOString() },
      city: home ?? { lat: q.lat, lon: q.lon },
      radiusKm: 30,
      nodes: 40,
      disturbed: 0.15,
      seed: Math.floor(q.time / 1000) % 1_000_000,
    };
  }

  function describe(s: Scenario) {
    blurb.textContent = s.blurb;
    caption.textContent = s.truth ? 'Each line is a phone, and farther phones are lower; the slanted bands are the P and S waves arriving.' : 'Each line is a phone; with no quake, only local disturbances show.';
  }

  function choose(s: Scenario) {
    r.load(s);
    history.replaceState(null, '', `#replay/${s.id}`);
    frame(s);
    describe(s);
    nameQuake(s);
    renderPicker();
    renderRecent();
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

  let recentKey = '';
  function renderRecent() {
    const quakes = live.usgs.filter((q): q is typeof q & { mag: number } => q.mag !== null && q.mag >= MIN_REPLAY_MAG).slice(0, RECENT);
    const key = `${live.usgsState}|${r.sim?.scenario.id}|${quakes.map((q) => `${q.id} ${ago(q.time)}`)}`;
    if (key === recentKey) return;
    recentKey = key;
    const none = quakes.length
      ? null
      : live.usgsState === 'loading'
        ? 'Loading recent quakes from the USGS…'
        : live.usgsState === 'error'
          ? 'The USGS feed could not be reached, so there are no recent quakes to offer. The quakes above always replay.'
          : `No quake of M${MIN_REPLAY_MAG} or more in the USGS feed for the past ${live.usgsWindow}: phones would barely feel smaller ones.`;
    keepFocus(recent, () =>
      recent.replaceChildren(
        ...(none
          ? [h('li', { class: 'small muted' }, none)]
          : quakes.map((q) =>
              h(
                'li',
                {},
                h('b', { class: 'mono' }, mag(q.mag)),
                h('span', {}, q.place, h('small', {}, ` · ${ago(q.time)}`)),
                h(
                  'button',
                  {
                    class: 'btn',
                    'aria-pressed': String(r.sim?.scenario.id === quakeLink(q)),
                    'aria-label': `Replay with simulated phones: ${mag(q.mag)}, ${q.place}`,
                    onclick: () => choose(quakeScenario(q)),
                  },
                  'Replay with simulated phones',
                ),
              ),
            )),
      ),
    );
  }

  function timeline() {
    const sim = r.sim!;
    const truth = sim.scenario.truth;
    const rows: [string, number | null, string][] = [
      ['Rupture', truth ? ORIGIN_OFFSET_S * 1000 : null, truth ? `M${truth.mag.toFixed(1)}, ${Math.round(truth.depthKm)} km deep` : 'no earthquake in this scenario'],
      ['First phone picks', r.firstPickAt, truth ? 'first wave felt; sent typically within a second of the shaking arriving, before any vetting' : 'a disturbance; sent typically within a second of it starting, before any vetting'],
      ['Network declares', r.declared?.at ?? null, r.declared ? `${r.declared.event.triggers.length} simulated phones agree and the quiet ones do not outvote them` : 'needs picks from 4 phones in 3 places that fit one wavefront'],
      ['Confirmed and sized', r.confirmedAt, r.events.length ? `vetted triggers from ${r.events[0].triggers.length} simulated phones, magnitude from their peak shaking` : 'each phone checks its shaking for 15–30 s first'],
    ];
    steps.replaceChildren(
      ...rows.map(([label, at, note]) =>
        h(
          'li',
          { class: at !== null && at <= r.vt ? 'done' : '' },
          h('span', { class: 'when mono' }, at !== null && at <= r.vt ? clockText(at) : '—'),
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
      const { confirmed, withdrawn } = r.counts();
      const caught = `${many(withdrawn, 'local disturbance was', 'local disturbances were')} caught and withdrawn by the phones themselves`;
      return h(
        'section',
        { class: 'warn-card calm', 'data-testid': 'warning' },
        h('b', {}, r.declared ? 'False alert' : 'No alert'),
        h(
          'p',
          {},
          r.declared
            ? 'The network declared a quake that did not happen. This is the failure mode early warning has to keep rare.'
            : confirmed
              ? `${caught}. ${confirmed} more passed ${confirmed === 1 ? 'its phone’s' : 'their phones’'} own checks but never lined up into a wavefront the quiet phones could agree with.`
              : `${caught}; the picks never lined up into a wavefront the quiet phones could agree with.`,
        ),
      );
    }
    if (!w && r.vt >= r.duration)
      return h('section', { class: 'warn-card calm', 'data-testid': 'warning' }, h('b', {}, 'No alert'), h('p', {}, 'These phones never declared the quake, so they would have sent no warning.'));
    if (!w) return h('section', { class: 'warn-card pending', 'data-testid': 'warning' }, h('b', {}, 'Early warning'), h('p', {}, 'Waiting for enough phones to feel the first waves…'));
    const felt = w.warnings.length;
    const sorted = [...w.warnings].sort((a, b) => b - a);
    const up = Math.max(0, sorted[0] ?? 0);
    const down = Math.max(0, -(sorted[sorted.length - 1] ?? 0));
    const span = Math.max(1, up + down);
    const truth = sim.scenario.truth;
    const lines: [string, string][] = [];
    if (named?.id === sim.scenario.id) {
      if (named.town) lines.push(['warning-near', nearLine(named.town.name, distanceKm(named.town, truth), warningNear(w.phones, named.town, NEAR_PLACE_KM), NEAR_PLACE_KM)]);
      const mine = saved && here(named.town) ? warningNear(w.phones, saved, NEAR_PLACE_KM) : null;
      if (saved && mine) lines.push(['warning-near-you', nearLine(savedName ?? 'your saved location', distanceKm(saved, truth), mine, NEAR_PLACE_KM)]);
    }
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
        ' simulated phones that felt it would have been warned before the strong shaking',
        w.median !== null ? h('span', {}, ` (median ${w.median.toFixed(1)} s, up to ${sorted[0].toFixed(1)} s)`) : null,
        '.',
      ),
      ...lines.map(([id, text]) => h('p', { class: 'warn-near', 'data-testid': id }, text)),
      h(
        'div',
        { class: 'bars-wrap', style: `--base:${(down / span) * 100}%` },
        h('div', { class: 'bars-axis', 'aria-hidden': 'true' }, h('span', { class: 'ax-up' }, up > 0 ? `+${up.toFixed(0)} s` : ''), h('span', { class: 'ax-zero' }, '0 s'), h('span', { class: 'ax-down' }, down > 0 ? `−${down.toFixed(0)} s` : '')),
        h(
          'div',
          { class: 'bars', role: 'img', 'aria-label': `Warning time of each simulated phone that felt it, longest first: from ${sorted[0].toFixed(1)} s to ${sorted[sorted.length - 1].toFixed(1)} s` },
          ...sorted.map((x) => h('i', { class: x > 0 ? 'pos' : 'neg', style: `--h:${(Math.abs(x) / span) * 100}%` })),
        ),
      ),
      h(
        'p',
        { class: 'small muted' },
        'Each bar is one simulated phone that felt the quake, longest warning first. Above the line, in red: seconds of warning, the alert reached it before the strong shaking. Below the line, in grey: the shaking came first, so no warning.',
      ),
      h(
        'p',
        { class: 'small muted' },
        `Inside ${w.blindKm.toFixed(0)} km the shaking beat the alert (the blind zone). Official warning systems use seconds like these to have people drop, cover and hold on, slow trains and open fire-station doors; Tremor reaches only the screens that have it open.`,
      ),
    );
  }

  /** What a press on a simulated phone says; null where there is nothing to say. */
  function phoneInfo(id: string): string | null {
    const sim = r.sim;
    const i = r.nodes.findIndex((n) => n.id === id);
    if (!sim || i < 0) return null;
    const truth = sim.scenario.truth;
    if (!truth) {
      const why = r.nodes[i].rejects.find((x) => x.at <= r.vt)?.reason;
      return `Simulated phone. No earthquake in this scenario${why ? `; it withdrew a pick: ${WITHDRAWN[why]}` : ''}.`;
    }
    const w = r.warning();
    return phoneNote(w?.phones[i] ?? { lat: r.nodes[i].lat, lon: r.nodes[i].lon, epicentreKm: distanceKm(truth, r.nodes[i]), s: 0, felt: true }, !!w);
  }
  let phonesKey = '';
  /** Every phone as a list a keyboard can reach: the same note as pressing its dot. Built once the alert is known, so it stays open while reading. */
  function phoneList() {
    const w = r.warning();
    const key = w ? `${r.sim!.scenario.id}|${w.alertAt}` : '';
    if (key === phonesKey) return;
    phonesKey = key;
    if (!w) return void phones.replaceChildren();
    const rows = w.phones.map((p, i) => ({ p, id: r.nodes[i].id })).sort((a, b) => a.p.epicentreKm - b.p.epicentreKm);
    phones.replaceChildren(
      h(
        'details',
        { class: 'phone-list', 'data-testid': 'phone-list' },
        h('summary', {}, `Phone by phone (${rows.length})`),
        h('p', { class: 'small muted' }, 'Nearest the epicentre first. Pressing one opens its note on the map, as pressing its dot does.'),
        h(
          'ul',
          {},
          ...rows.map(({ p, id }) =>
            h(
              'li',
              {},
              h(
                'button',
                { class: 'btn', onclick: () => map.showNode(id) },
                `${p.epicentreKm.toFixed(1)} km from the epicentre · ${!p.felt ? 'barely felt' : p.s > 0 ? `${p.s.toFixed(1)} s warning` : `shaking ${(-p.s).toFixed(1)} s before the alert`}`,
              ),
            ),
          ),
        ),
      ),
    );
  }

  function milestone() {
    const { declared, confirmedAt } = r;
    const real = !!r.sim?.scenario.truth;
    if (r.vt >= r.duration) {
      if (!declared) return 'Replay finished: no quake declared.';
      if (!real) return `Replay finished: a false alert at ${clockText(declared.at)}.`;
      return `Replay finished: declared at ${clockText(declared.at)}${confirmedAt !== null ? `, confirmed at ${clockText(confirmedAt)}` : ''}.`;
    }
    if (confirmedAt !== null) return `Confirmed at ${clockText(confirmedAt)}.`;
    if (!declared) return '';
    return real ? `Network declares a quake at ${clockText(declared.at)}.` : `False alert: the network declares a quake at ${clockText(declared.at)}.`;
  }

  let lastKey = '';
  let lastHeavy = 0;
  function update() {
    const sim = r.sim;
    if (!sim) return;
    const t = r.clockAt(r.vt);
    const truth = sim.scenario.truth;
    const m = milestone();
    if (said.textContent !== m) said.textContent = m;
    clock.textContent = clockText(r.vt);
    scrub.value = String(Math.round((r.vt / r.duration) * 1000));
    scrub.setAttribute('aria-valuetext', truth ? `${Math.abs(t).toFixed(0)} seconds ${t < 0 ? 'before' : 'after'} the quake began` : `${Math.floor(t)} seconds into the replay`);
    playBtn.textContent = r.playing ? 'Pause' : r.vt >= r.duration ? 'Replay' : 'Play';
    speeds.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === r.speed)));

    // Map and canvas are the expensive part: ~15 fps is plenty.
    const now = performance.now();
    if (r.playing && now - lastHeavy < 66) return;
    lastHeavy = now;

    const { confirmed: trig, withdrawn, why } = r.counts();
    const tally = [...why].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${WITHDRAWN[k]} ${n}`);
    stats.textContent = `${many(r.nodes.length, 'simulated phone')} · ${trig} confirmed · ${withdrawn ? `${many(withdrawn, 'pick')} withdrawn on-device (${tally.join(', ')})` : 'no picks withdrawn'}`;
    map.setNodes(r.nodes.map((n) => ({ id: n.id, lat: n.lat, lon: n.lon, state: r.nodeState(n), shake: r.shake(n) })));
    map.setWaves(r.waves());
    map.setTruth(truth && t > 0 ? truth : null);
    map.setEvents([
      ...r.events.map((e) => ({ id: e.id, lat: e.lat, lon: e.lon, mag: e.mag, selected: true, members: e.triggers })),
      ...r.provisional.map((e) => ({ id: 'early', lat: e.lat, lon: e.lon, mag: null, provisional: true, members: e.triggers })),
    ]);
    const w = r.warning();
    const rings: MapRing[] =
      w && truth && r.vt >= r.declared!.at
        ? [
            { center: truth, km: w.blindKm, kind: 'blind', label: 'blind zone' },
            ...ISOCHRONS.map((s) => ({ center: truth, km: sRadiusKm(w.alertAt + s, truth.depthKm), kind: 'iso' as const, label: `${s} s warning` })),
          ]
        : [];
    const located = r.events[0];
    map.setRings(located ? [...rings, { center: located, km: eventUncertainty(located).km, kind: 'error', label: give(eventUncertainty(located)) }] : rings);
    drawSection(canvas, r);

    const key = `${r.events.length}|${r.declared?.at}|${trig}|${r.vt >= r.duration}|${r.playing}|${Math.floor(r.vt / 1000)}`;
    if (key === lastKey) return;
    lastKey = key;
    map.setShake(r.events.length ? shakeGrid(r.events[0].triggers) : []);
    timeline();
    warn.replaceChildren(warningCard());
    phoneList();
    const ev = r.events[0];
    result.replaceChildren(
      ev
        ? compareCard(
            'Simulated phones located it',
            ev,
            truth ? { lat: truth.lat, lon: truth.lon, time: sim.origin, mag: truth.mag, label: 'USGS catalogue', url: usgsEventUrl(truth.usgsId) } : null,
            'No real earthquake in this scenario, so this would be a false alarm.',
          )
        : '',
      ev && truth
        ? h(
            'p',
            { class: 'small muted' },
            'Simulated phones shake by the same model Tremor sizes quakes with, so their magnitude matches by design. Real phones are rougher, and big quakes read low: Android’s phone network put Türkiye’s 2023 M7.8 at M4.5–4.9.',
          )
        : '',
    );
  }

  root.append(
    h('div', {}, h('h1', {}, 'Replay'), h('p', { class: 'lede' }, 'Real quakes, historical or from the past day, played into a simulated network of phones. Every trace runs through the same detector your phone would, and every alert through the same network logic.')),
    picker,
    h('section', {}, h('h2', {}, 'Recent quakes', h('small', {}, 'USGS feed')), recent),
    blurb,
    said,
    h('div', { class: 'transport' }, playBtn, clock, speeds),
    scrub,
    steps,
    warn,
    phones,
    result,
    h(
      'section',
      {},
      h('h2', {}, 'Record section', h('small', {}, 'distance vs time')),
      caption,
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
  map.nodeInfo = phoneInfo;
  renderPicker();
  const off = r.on(update);
  const offLive = live.on(renderRecent);
  const linked = initial ? parseQuakeLink(initial) : null;
  // With no scenario in the address (the Replay tab), the one already loaded carries on.
  const start = SCENARIOS.find((s) => s.id === initial) ?? (linked ? quakeScenario(linked) : (!initial && r.sim?.scenario) || SCENARIOS[0]);
  if (r.sim?.scenario.id !== start.id) choose(start);
  else {
    // Back on the scenario already loaded: pick up where it was, with its own address.
    history.replaceState(null, '', `#replay/${start.id}`);
    frame(start);
    describe(start);
    nameQuake(start);
    renderRecent();
    update();
  }
  if (initial && !linked && !SCENARIOS.some((s) => s.id === initial)) blurb.textContent = `That replay link is incomplete or out of range, so ${start.title} plays instead. ${start.blurb}`;
  const onResize = () => drawSection(canvas, r);
  window.addEventListener('resize', onResize);
  return {
    el: root,
    dispose: () => {
      gone = true;
      off();
      offLive();
      r.pause();
      map.setPlaces([]);
      map.setRings([]);
      map.setShake([]);
      window.removeEventListener('resize', onResize);
    },
  };
}
