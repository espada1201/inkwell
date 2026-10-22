import { NODE_STALE_MS, SETTLE_MS, WINDOW_MS, type LiveNetwork, type Provisional } from '../app/live';
import { NOTICED_LEVEL, fromPlace, nearYou, type Near, type Place } from '../app/near';
import { eventUncertainty } from '../core/associate';
import { distanceKm, type LatLon } from '../core/geo';
import { shakeGrid } from '../core/impact';
import { isRelayUrl, reach } from '../net/transport';
import { matchUsgs, type UsgsQuake } from '../net/usgs';
import { h, keepFocus } from '../ui/dom';
import { INTENSITY_WORDS, WITHDRAWN, ago, clock, coord, mag, magBadge } from '../ui/format';
import { NODE_COLORS, SHAKE_COLORS, type QuakeMap, type Swatch } from '../ui/map';
import { compareCard, give } from './compare';
import { placeForm } from './place';

/** The map key for the live network (also shown behind the sensor and About screens). */
export const NETWORK_LEGEND: Swatch[] = [
  [NODE_COLORS.idle, 'phone'],
  [NODE_COLORS.pick, 'felt shaking, still checking'],
  [NODE_COLORS.trigger, 'confirmed shaking / Tremor detection'],
  ['transparent;border:2px solid var(--red)', 'provisional detection'],
  ['transparent;border:1px dashed var(--ink)', 'where a detection could be'],
  ['transparent;border:1.5px solid var(--ink)', 'USGS earthquake'],
  [`${SHAKE_COLORS[3]};border:1px solid var(--ink)`, 'people felt shaking'],
  [NODE_COLORS.offline, 'phone offline'],
];

/** The status dot for how well the relays can be reached, in the header and the relay list. */
export const REACH_DOT = { open: 'ok', connecting: 'warn', down: 'bad' } as const;

export interface NetworkCtx {
  live: LiveNetwork;
  map: QuakeMap;
  relays: string[];
  saveRelays: (urls: string[]) => void;
  place: Place;
  openFelt: () => void;
  /** The opt-in chime for shaking confirmed near you. */
  chime: { readonly on: boolean; set(on: boolean): void };
}

type Selection = { kind: 'event' | 'usgs'; id: string };
const HOURS = WINDOW_MS / 3600_000;
const USGS_SHOWN = 12;
const USGS_GAP = 'Outside the US, USGS may not list quakes below about M4.5.';
const feltText = (c: { people: number; places: number }) => `${c.people} people in ${c.places} places felt shaking`;
const nearTitle = (x: Near) => (x.kind === 'felt' ? feltText(x) : x.kind === 'usgs' ? `USGS: ${x.place}` : x.kind === 'provisional' ? 'Provisional Tremor detection' : 'Tremor detection');

function outcomeText(d: Provisional, usgs: UsgsQuake[]) {
  if (d.confirmed) return `Confirmed: ${mag(d.confirmed.mag)}${matchUsgs(d.confirmed, usgs) ? ', matches USGS' : ''}`;
  const w = d.withdrew;
  const why = w.length ? `${w.length} of ${d.picks.length} phones withdrew (${[...new Set(w.map((x) => (x.reason ? WITHDRAWN[x.reason] : 'no reason given')))].join(', ')}) at ${clock(Math.max(...w.map((x) => x.at)))}` : '';
  if (d.outcome === 'withdrawn') return `Not confirmed: ${why}`;
  if (d.outcome === 'unconfirmed') return `Still unconfirmed after ${SETTLE_MS / 60_000} min${why && `; ${why}`}`;
  return 'Waiting for the phones to confirm';
}

export function networkView(ctx: NetworkCtx) {
  const { live, map, place } = ctx;
  let selected: Selection | null = null;
  let flewToData = false;
  let moving = false;
  let worldwide = false;
  const root = h('div', { class: 'panel-inner' });
  const announcer = h('p', { class: 'sr-only', role: 'alert' });
  const told = new Map(live.provisional.filter((d) => d.outcome !== 'open').map((d) => [d, d.outcome]));

  const part = (parent: HTMLElement = root) => {
    let shown: ChildNode = parent.appendChild(document.createComment(''));
    let html = '';
    return (next: HTMLElement | null) => {
      const nextHtml = next?.outerHTML ?? '';
      if (nextHtml === html) return;
      html = nextHtml;
      const node = next ?? document.createComment('');
      keepFocus(root, () => shown.replaceWith(node));
      shown = node;
    };
  };

  root.append(
    announcer,
    h(
      'div',
      {},
      h('h1', {}, 'Live network'),
      h('p', { class: 'lede' }, 'Earthquakes caught by volunteers’ phones, wherever someone has set one up, and by what people felt, checked against the official USGS feed.'),
    ),
  );
  const parts = { near: part(), stats: part(), provisional: part(), detail: part(), detections: part(), felt: part(), usgs: part() };
  root.append(
    h(
      'p',
      { class: 'honest' },
      'Community science, not an official warning system. Phones only feel fairly strong shaking, and anyone can publish to public relays. For official alerts: on Android, turn on Earthquake alerts in Settings under Safety & emergency (the path varies by maker); on the US West Coast, keep Wireless Emergency Alerts on and add the MyShake app; elsewhere, follow your national seismic service.',
    ),
  );
  const relays = relaysBox();

  map.clear();
  map.onSelect = (kind, id) => {
    selected = { kind, id };
    render();
  };

  function select(kind: Selection['kind'], id: string) {
    selected = { kind, id };
    const at = kind === 'event' ? live.events.find((e) => e.id === id) : live.usgs.find((q) => q.id === id);
    if (at) map.fly(at, kind === 'event' ? 8 : 7);
    render();
    // The details open above the lists; take the reader, and the keyboard, to them.
    const shown = root.querySelector<HTMLElement>('[data-key=detail]');
    shown?.scrollIntoView({ block: 'nearest' });
    shown?.focus({ preventScroll: true });
  }

  function syncMap() {
    const now = Date.now();
    const winMs = live.usgsWindow === 'hour' ? 3600_000 : 86400_000;
    map.setUsgs(live.usgs.map((q) => ({ id: q.id, lat: q.lat, lon: q.lon, mag: q.mag, age: Math.min(1, (now - q.time) / winMs) })));
    map.setNodes(live.nodeStates(now));
    map.setFelt(live.feltClusters.flatMap((c) => c.reports));
    const sel = selected?.kind === 'event' ? live.events.find((e) => e.id === selected!.id) : null;
    map.setRings([...(sel ? [sel] : []), ...live.early].map((e) => ({ center: e, km: eventUncertainty(e).km, kind: 'error' as const, label: give(eventUncertainty(e)) })));
    map.setEvents([
      ...live.events.map((e) => ({
        id: e.id,
        lat: e.lat,
        lon: e.lon,
        mag: e.mag,
        selected: selected?.kind === 'event' && selected.id === e.id,
        members: e.triggers,
      })),
      ...live.early.map((e) => ({ id: e.id, lat: e.lat, lon: e.lon, mag: null, provisional: true, selected: true, members: e.triggers })),
    ]);
    map.setShake(sel ? shakeGrid(sel.triggers) : []);
    const newest = live.early[0] ?? live.events[live.events.length - 1];
    if (!flewToData && newest) {
      flewToData = true;
      map.fly(newest, 7);
    }
  }

  function announce() {
    const news = live.provisional
      .filter((d) => told.get(d) !== d.outcome)
      .map((d) => {
        told.set(d, d.outcome);
        return d.outcome === 'open' ? `Provisional earthquake detection near ${coord(d.event.lat, d.event.lon)}. Waiting for the phones to confirm.` : `${outcomeText(d, live.usgs)}.`;
      });
    if (news.length) announcer.textContent = news.join(' ');
  }

  function nearCard() {
    const you = place.location;
    const card = (...body: (Node | null)[]) => h('section', { class: 'near', 'data-testid': 'near', 'aria-labelledby': 'near-title' }, h('h2', { id: 'near-title' }, 'Shaking near you?'), ...body);
    if (!you || (moving && !place.canPublish))
      return card(
        placeForm(place, () => {
          moving = false;
          render();
          root.querySelector<HTMLElement>('[data-key=move]')?.focus();
        }),
      );
    const near = nearYou(live, you);
    const heard = reach(live.transport.statuses()) === 'open';
    const noticed = near.some((x) => x.level !== null && x.level >= NOTICED_LEVEL);
    const move = () => {
      moving = true;
      render();
      root.querySelector<HTMLElement>('[data-key=locate]')?.focus();
    };
    return card(
      h(
        'p',
        { class: 'small muted' },
        `Near ${place.placeName ? `${place.placeName} (${coord(you.lat, you.lon)})` : coord(you.lat, you.lon)} · `,
        place.canPublish ? h('a', { href: '#sensor' }, 'change it under Be a sensor') : h('button', { class: 'link', 'data-key': 'move', onclick: move }, 'change'),
        place.canPublish ? ', since this phone shares it' : null,
      ),
      near.length
        ? h(
            'ul',
            { class: 'list near-list' },
            ...near.map((x) =>
              h(
                'li',
                { 'data-testid': 'near-item' },
                h('span', { class: `badge${x.kind === 'provisional' || x.kind === 'confirmed' ? ' ours' : ''}` }, x.kind === 'felt' ? 'felt' : magBadge(x.mag)),
                h('span', {}, nearTitle(x), h('br'), h('span', { class: 'small muted' }, `${Math.round(x.km)} km ${fromPlace(place)}${x.level === null ? '' : ` · ${x.kind === 'felt' ? 'typically' : 'rough local shaking:'} ${INTENSITY_WORDS[x.level]}`}`)),
                h('span', { class: 'when' }, ago(x.time)),
              ),
            ),
          )
        : h(
            'p',
            { class: 'empty' },
            live.usgsState === 'loading'
              ? 'Checking the USGS feed…'
              : live.usgsState === 'error' && !heard
                ? 'Neither the USGS feed nor any relay can be reached right now, so Tremor cannot tell whether anything shook near you.'
                : 'Nothing strong enough to feel has been reported near you yet. USGS usually posts within about 2.5 min in California, about 8 min elsewhere in the US and about 20 min abroad.',
            live.usgsState === 'error' && heard ? ' The USGS feed cannot be reached right now, so this is from Tremor alone.' : null,
            live.usgsState === 'ok' && !heard ? ' No relay is connected yet, so this is from USGS alone.' : null,
          ),
      h('p', {}, h('button', { class: 'btn', onclick: ctx.openFelt }, 'I felt it')),
      h(
        'label',
        { class: 'switch' },
        h('input', { type: 'checkbox', 'data-key': 'chime', checked: ctx.chime.on, 'aria-describedby': 'chime-help', onchange: (e: Event) => ctx.chime.set((e.target as HTMLInputElement).checked) }),
        h('span', {}, 'Chime when shaking is confirmed near me'),
      ),
      h('p', { class: 'small muted', id: 'chime-help' }, 'Only while Tremor is open: a closed tab cannot alert you. It chimes for light or stronger shaking that phones confirmed or USGS lists, never for provisional detections or for what people say they felt.'),
      noticed ? h('p', { class: 'small' }, 'If the ground shakes again: Drop, Cover and Hold On.', h('br'), 'Expect aftershocks, sometimes for days.') : null,
      noticed ? h('p', { class: 'small' }, 'Help next time: ', h('a', { href: '#sensor' }, 'leave an old phone on charge with Tremor open'), '.') : null,
    );
  }

  function statsRow() {
    const st = live.transport.statuses();
    const phones = [...live.nodes.values()].filter((n) => live.isOnline(n)).length;
    const one = (n: number, word: string, words: string) => (n === 1 ? word : words);
    return h(
      'div',
      { class: 'stats', title: `Phones listening now (heard from in the last ${NODE_STALE_MS / 60_000} minutes); confirmed reports and quakes from the last ${HOURS} hours` },
      h('div', {}, h('b', { 'data-testid': 'stat-nodes' }, phones), h('span', {}, one(phones, 'phone', 'phones'))),
      h('div', {}, h('b', {}, live.triggers.length), h('span', {}, one(live.triggers.length, 'confirmed report', 'confirmed reports'))),
      h('div', {}, h('b', { 'data-testid': 'stat-events' }, live.events.length), h('span', {}, one(live.events.length, 'quake', 'quakes'))),
      h('div', {}, h('b', {}, `${st.filter((s) => s.state === 'open').length}/${st.length}`), h('span', {}, 'relays')),
    );
  }

  function provisionalCards() {
    const ended = live.provisional.filter((d) => !live.early.includes(d.event)).reverse();
    if (!live.early.length && !ended.length) return null;
    return h(
      'div',
      { class: 'stack' },
      ...live.early.map((e) =>
        h(
          'section',
          { class: 'warn-card', 'data-testid': 'provisional' },
          h('header', {}, h('b', {}, 'Provisional detection'), h('span', { class: 'mono' }, ago(e.time))),
          h('p', {}, `${e.triggers.length} phones felt shaking start in a pattern that fits one source near ${coord(e.lat, e.lon)} (${give(eventUncertainty(e))}), and the phones nearby that stayed quiet do not outvote them. Waiting for the phones to confirm.`),
        ),
      ),
      ended.length
        ? h(
            'section',
            {},
            h('h2', {}, 'Provisional detections', h('small', {}, `last ${HOURS} hours, while this page is open`)),
            h('ul', { class: 'list lines' }, ...ended.map((d) => h('li', { 'data-testid': 'outcome' }, h('span', {}, outcomeText(d, live.usgs)), h('span', { class: 'when' }, ago(d.event.time))))),
          )
        : null,
    );
  }

  /** The open details take focus when chosen, and keep it while the panel redraws. */
  const detailKey = (el: HTMLElement) => {
    el.tabIndex = -1;
    el.dataset.key = 'detail';
    return el;
  };

  function detailCard() {
    const ev = selected?.kind === 'event' ? live.events.find((e) => e.id === selected!.id) : null;
    if (ev) {
      const m = matchUsgs(ev, live.usgs);
      const card = compareCard(
        'Network detection',
        ev,
        m ? { lat: m.quake.lat, lon: m.quake.lon, time: m.quake.time, mag: m.quake.mag, label: 'USGS', url: m.quake.url } : null,
        live.usgsState === 'ok' ? `No matching USGS event yet. Official solutions can take minutes, or this may be a false alarm. ${USGS_GAP}` : 'USGS feed unavailable, cannot cross-check right now.',
      );
      if (place.location) card.querySelector('header')!.after(h('p', { class: 'small', 'data-testid': 'detail-km' }, `${Math.round(distanceKm(place.location, ev))} km ${fromPlace(place)}`));
      return detailKey(card);
    }
    const q = selected?.kind === 'usgs' ? live.usgs.find((x) => x.id === selected!.id) : null;
    return q
      ? detailKey(
          h(
            'section',
            { class: 'compare', 'aria-label': 'USGS event' },
            h('header', {}, h('b', {}, `${mag(q.mag)} · ${q.place}`), h('a', { href: q.url, target: '_blank', rel: 'noopener', class: 'small' }, 'USGS ↗')),
            place.location ? h('p', { class: 'small', 'data-testid': 'detail-km' }, `${Math.round(distanceKm(place.location, q))} km ${fromPlace(place)}`) : null,
            h('p', { class: 'verdict mono small' }, `${coord(q.lat, q.lon)} · depth ${q.depthKm.toFixed(0)} km · ${ago(q.time)}`),
          ),
        )
      : null;
  }

  function detections() {
    const relays = reach(live.transport.statuses());
    const empty = (...text: (string | Node)[]) => h('p', { class: 'empty', 'data-testid': 'no-events' }, ...text);
    return h(
      'section',
      {},
      h('h2', {}, 'Detected by Tremor', h('small', {}, `last ${HOURS} hours`)),
      relays === 'down'
        ? h('p', { class: 'empty', role: 'status' }, 'Not connected to any relay, so nothing can be heard. Tremor keeps retrying; check your connection or the relay list below.')
        : null,
      live.events.length
        ? h(
            'ul',
            { class: 'list', 'data-testid': 'event-list' },
            ...[...live.events].reverse().map((e) => {
              const m = matchUsgs(e, live.usgs);
              return h(
                'li',
                {},
                h(
                  'button',
                  { class: 'row', 'aria-pressed': selected?.kind === 'event' && selected.id === e.id ? 'true' : 'false', 'data-key': `event:${e.id}`, onclick: () => select('event', e.id) },
                  h('span', { class: 'badge ours' }, magBadge(e.mag)),
                  h('span', { class: 'where' }, m ? `Matches USGS: ${m.quake.place}` : coord(e.lat, e.lon), h('br'), h('span', { class: 'small muted' }, `${e.triggers.length} phones agreed · compare ›`)),
                  h('span', { class: 'when' }, ago(e.time)),
                ),
              );
            }),
          )
        : relays === 'down'
          ? null
          : relays === 'connecting'
            ? empty('Connecting to the relays…')
            : live.early.length
              ? empty('No confirmed detections yet.')
              : empty(
                  `No network detections in the past ${HOURS} hours. That is normal: phones only notice strong shaking close by. `,
                  h('a', { href: '#replay' }, 'Watch a replay'),
                  ' or ',
                  h('a', { href: '#sensor' }, 'turn this phone into a sensor'),
                  '.',
                ),
    );
  }

  function feltSection() {
    if (!live.feltClusters.length) return null;
    return h(
      'section',
      {},
      h('h2', {}, 'Felt reports', h('small', {}, `last ${HOURS} hours`)),
      h(
        'ul',
        { class: 'list lines' },
        ...[...live.feltClusters]
          .reverse()
          .map((c) =>
            h(
              'li',
              { 'data-testid': 'felt' },
              h('span', {}, `${feltText(c)}, typically ${INTENSITY_WORDS[c.lvl]}`, h('br'), h('span', { class: 'small muted' }, `around ${coord(c.lat, c.lon)}`)),
              h('span', { class: 'when' }, ago(c.time)),
            ),
          ),
      ),
    );
  }

  function quakeRow(q: UsgsQuake, you: LatLon | null) {
    return h(
      'li',
      {},
      h(
        'button',
        { class: 'row', 'aria-pressed': selected?.kind === 'usgs' && selected.id === q.id ? 'true' : 'false', 'data-key': `usgs:${q.id}`, onclick: () => select('usgs', q.id) },
        h('span', { class: 'badge' }, magBadge(q.mag)),
        h('span', { class: 'where' }, q.place, you && h('br'), you && h('span', { class: 'small muted' }, `${Math.round(distanceKm(you, q))} km ${fromPlace(place)}`)),
        h('span', { class: 'when' }, ago(q.time)),
      ),
    );
  }

  function usgsSection() {
    const you = place.location;
    const quakes = you && !worldwide ? [...live.usgs].sort((a, b) => distanceKm(you, a) - distanceKm(you, b)) : live.usgs;
    const body =
      live.usgsState === 'loading' && !live.usgs.length
        ? h('div', {}, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))
        : live.usgsState === 'error'
          ? h('p', { class: 'empty', role: 'status' }, 'The USGS feed could not be reached. Retrying every two minutes.')
          : live.usgs.length === 0
            ? h('p', { class: 'empty' }, `No earthquakes listed in the past ${live.usgsWindow}.`)
            : h(
                'div',
                {},
                h('ul', { class: 'list', 'data-testid': 'usgs-list' }, ...quakes.slice(0, USGS_SHOWN).map((q) => quakeRow(q, you))),
                quakes.length > USGS_SHOWN ? h('p', { class: 'small muted' }, `The ${USGS_SHOWN} ${you && !worldwide ? 'nearest' : 'newest'} of ${quakes.length} are shown.`) : null,
              );
    return h(
      'section',
      {},
      h(
        'h2',
        {},
        'Official · USGS',
        h(
          'span',
          { class: 'seg', role: 'group', 'aria-label': 'USGS time window' },
          ...(['hour', 'day'] as const).map((w) => h('button', { 'aria-pressed': live.usgsWindow === w ? 'true' : 'false', onclick: () => live.setUsgsWindow(w) }, `past ${w}`)),
        ),
      ),
      you
        ? h(
            'span',
            { class: 'seg usgs-order', role: 'group', 'aria-label': 'Order of the USGS list' },
            ...([['nearest first', false], ['worldwide', true]] as const).map(([label, w]) =>
              h(
                'button',
                {
                  'aria-pressed': worldwide === w ? 'true' : 'false',
                  onclick: () => {
                    worldwide = w;
                    render();
                  },
                },
                label,
              ),
            ),
          )
        : null,
      body,
      h('p', { class: 'small muted usgs-gap' }, USGS_GAP),
    );
  }

  function relaysBox() {
    const note = h('p', { class: 'small relays-note', role: 'status', id: 'relays-note' });
    const ta = h('textarea', { 'aria-label': 'Relay URLs, one per line', 'aria-describedby': 'relays-note', spellcheck: 'false' });
    ta.value = ctx.relays.join('\n');
    const save = () => {
      const lines = ta.value.split(/[\s,]+/).filter(Boolean);
      const wrong = lines.filter((s) => !isRelayUrl(s));
      if (lines.length && !wrong.length) return ctx.saveRelays(lines);
      ta.setAttribute('aria-invalid', 'true');
      note.textContent = wrong.length ? `Relay addresses start with wss://. Fix or remove these lines, then save again: ${wrong.join(', ')}.` : 'Add at least one relay address. Relay addresses start with wss://.';
    };
    const el = h('details', { class: 'relays' }, h('summary', {}, 'Relays'));
    const list = part(el);
    el.append(
      ta,
      note,
      h('p', { class: 'small muted' }, 'Most public Nostr relays work. Tremor events are tagged #tremor: kind 4578 picks, kind 5 retractions, kind 4579 confirmed reports, kind 34579 heartbeats and kind 4580 felt reports.'),
      h('button', { class: 'btn', onclick: save }, 'Save and reconnect'),
    );
    root.append(el);
    return () =>
      list(
        h(
          'ul',
          { class: 'relay-list' },
          ...live.transport.statuses().map((s) => {
            const r = reach([s]);
            return h('li', {}, h('i', { class: `dot ${REACH_DOT[r]}` }), h('span', {}, s.url), h('span', { class: 'muted' }, ` ${r === 'down' ? 'unreachable, retrying' : r} · ↓${s.received}`));
          }),
        ),
      );
  }

  function render() {
    announce();
    parts.near(nearCard());
    parts.stats(statsRow());
    parts.provisional(provisionalCards());
    parts.detail(detailCard());
    parts.detections(detections());
    parts.felt(feltSection());
    parts.usgs(usgsSection());
    relays();
    syncMap();
  }

  let queued = false;
  const off = live.on(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  });
  const tick = setInterval(render, 15_000);
  render();
  return {
    el: root,
    dispose: () => {
      off();
      clearInterval(tick);
      map.onSelect = () => {};
    },
  };
}
