import { NODE_STALE_MS, SETTLE_MS, WINDOW_MS, type LiveNetwork, type Provisional } from '../app/live';
import { shakeGrid } from '../core/impact';
import type { RejectReason } from '../core/sensor';
import { reach } from '../net/transport';
import { matchUsgs, type UsgsQuake } from '../net/usgs';
import { h, keepFocus } from '../ui/dom';
import { ago, coord, mag, magBadge } from '../ui/format';
import { NODE_COLORS, type QuakeMap, type Swatch } from '../ui/map';
import { compareCard } from './compare';

/** The map key for the live network (also shown behind the sensor and About screens). */
export const NETWORK_LEGEND: Swatch[] = [
  [NODE_COLORS.idle, 'phone'],
  [NODE_COLORS.pick, 'felt shaking, still checking'],
  [NODE_COLORS.trigger, 'confirmed shaking / Tremor detection'],
  ['transparent;border:2px solid var(--red)', 'provisional detection'],
  ['transparent;border:1.5px solid var(--ink)', 'USGS earthquake'],
  [NODE_COLORS.offline, 'phone offline'],
];

/** The status dot for how well the relays can be reached, in the header and the relay list. */
export const REACH_DOT = { open: 'ok', connecting: 'warn', down: 'bad' } as const;

export interface NetworkCtx {
  live: LiveNetwork;
  map: QuakeMap;
  relays: string[];
  saveRelays: (urls: string[]) => void;
}

type Selection = { kind: 'event' | 'usgs'; id: string };
/** How far back the panel looks. */
const HOURS = WINDOW_MS / 3600_000;
/** Why phones withdrew their picks, in the sensor log's words. */
const WITHDREW: Record<RejectReason, string> = { footsteps: 'footsteps', impulse: 'bump or door slam', handling: 'phone moved', interrupted: 'sensor paused' };
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** How a provisional detection ended, in the words of both the panel and the screen-reader announcer. */
function outcomeText(d: Provisional, usgs: UsgsQuake[]) {
  if (d.confirmed) return `Confirmed: ${mag(d.confirmed.mag)}${matchUsgs(d.confirmed, usgs) ? ', matches USGS' : ''}`;
  const w = d.withdrew;
  const why = w.length ? `${w.length} of ${d.picks.length} phones withdrew (${[...new Set(w.map((x) => (x.reason ? WITHDREW[x.reason] : 'no reason given')))].join(', ')}) at ${clock(Math.max(...w.map((x) => x.at)))}` : '';
  if (d.outcome === 'withdrawn') return `Not confirmed: ${why}`;
  if (d.outcome === 'unconfirmed') return `Still unconfirmed after ${SETTLE_MS / 60_000} min${why && `; ${why}`}`;
  return 'Waiting for the phones to confirm';
}

export function networkView(ctx: NetworkCtx) {
  const { live, map } = ctx;
  let selected: Selection | null = null;
  let flewToData = false;
  const root = h('div', { class: 'panel-inner' });
  // Screen readers hear once of each provisional detection and of how it ended; the rest of the panel is not a live region.
  const announcer = h('p', { class: 'sr-only', role: 'alert' });
  // What the announcer last said of each detection: those that had ended before this screen opened are old news.
  const told = new Map(live.provisional.filter((d) => d.outcome !== 'open').map((d) => [d, d.outcome]));

  /**
   * A part of the panel, swapped in only when what it shows has changed: the parts that did not
   * change keep focus, are not read out again, and keep whatever is being typed into them.
   */
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
      h('p', { class: 'lede' }, 'Phones lying still on tables, everywhere. Their triggers travel over public Nostr relays and are pieced together right here in your browser. No server.'),
    ),
  );
  const parts = { stats: part(), provisional: part(), detail: part(), detections: part(), usgs: part() };
  root.append(h('p', { class: 'honest' }, 'Community science, not an official warning system. Phones only feel fairly strong shaking, and anyone can publish to public relays. For official alerts use your national seismic service.'));
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
  }

  function syncMap() {
    const now = Date.now();
    const winMs = live.usgsWindow === 'hour' ? 3600_000 : 86400_000;
    map.setUsgs(live.usgs.map((q) => ({ id: q.id, lat: q.lat, lon: q.lon, mag: q.mag, age: Math.min(1, (now - q.time) / winMs) })));
    map.setNodes(live.nodeStates(now));
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
    const sel = selected?.kind === 'event' ? live.events.find((e) => e.id === selected!.id) : null;
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

  function statsRow() {
    const st = live.transport.statuses();
    return h(
      'div',
      { class: 'stats', title: `Phones listening now (heard from in the last ${NODE_STALE_MS / 60_000} minutes); triggers and quakes from the last ${HOURS} hours` },
      h('div', {}, h('b', { 'data-testid': 'stat-nodes' }, [...live.nodes.values()].filter((n) => live.isOnline(n)).length), h('span', {}, 'phones')),
      h('div', {}, h('b', {}, live.triggers.length), h('span', {}, 'triggers')),
      h('div', {}, h('b', { 'data-testid': 'stat-events' }, live.events.length), h('span', {}, 'quakes')),
      h('div', {}, h('b', {}, `${st.filter((s) => s.state === 'open').length}/${st.length}`), h('span', {}, 'relays')),
    );
  }

  /** Declared detections as cards; once no longer declared, each stays for two hours as a line saying how it ended. */
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
          h('p', {}, `${e.triggers.length} phones felt shaking start in a pattern that fits one source near ${coord(e.lat, e.lon)}, and the phones nearby that stayed quiet do not outvote them. Waiting for the phones to confirm.`),
        ),
      ),
      ended.length
        ? h(
            'section',
            {},
            h('h2', {}, 'Provisional detections', h('small', {}, `last ${HOURS} hours`)),
            h('ul', { class: 'list outcomes' }, ...ended.map((d) => h('li', { 'data-testid': 'outcome' }, h('span', {}, outcomeText(d, live.usgs)), h('span', { class: 'when' }, ago(d.event.time))))),
          )
        : null,
    );
  }

  function detailCard() {
    const ev = selected?.kind === 'event' ? live.events.find((e) => e.id === selected!.id) : null;
    if (ev) {
      const m = matchUsgs(ev, live.usgs);
      return compareCard(
        'Network detection',
        ev,
        m ? { lat: m.quake.lat, lon: m.quake.lon, time: m.quake.time, mag: m.quake.mag, label: 'USGS', url: m.quake.url } : null,
        live.usgsState === 'ok' ? 'No matching USGS event yet. Official solutions can take minutes, or this may be a false alarm.' : 'USGS feed unavailable, cannot cross-check right now.',
      );
    }
    const q = selected?.kind === 'usgs' ? live.usgs.find((x) => x.id === selected!.id) : null;
    return q
      ? h(
          'section',
          { class: 'compare', 'aria-label': 'USGS event' },
          h('header', {}, h('b', {}, `${mag(q.mag)} · ${q.place}`), h('a', { href: q.url, target: '_blank', rel: 'noopener', class: 'small' }, 'USGS ↗')),
          h('p', { class: 'verdict mono small' }, `${coord(q.lat, q.lon)} · depth ${q.depthKm.toFixed(0)} km · ${ago(q.time)}`),
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
                  h('span', { class: 'where' }, m ? `Matches USGS: ${m.quake.place}` : coord(e.lat, e.lon), h('br'), h('span', { class: 'small muted' }, `${e.triggers.length} phones agreed`)),
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

  function quakeRow(q: UsgsQuake) {
    return h(
      'li',
      {},
      h(
        'button',
        { class: 'row', 'aria-pressed': selected?.kind === 'usgs' && selected.id === q.id ? 'true' : 'false', 'data-key': `usgs:${q.id}`, onclick: () => select('usgs', q.id) },
        h('span', { class: 'badge' }, magBadge(q.mag)),
        h('span', { class: 'where' }, q.place),
        h('span', { class: 'when' }, ago(q.time)),
      ),
    );
  }

  function usgsSection() {
    const body =
      live.usgsState === 'loading' && !live.usgs.length
        ? h('div', {}, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))
        : live.usgsState === 'error'
          ? h('p', { class: 'empty', role: 'status' }, 'The USGS feed could not be reached. Retrying every two minutes.')
          : live.usgs.length === 0
            ? h('p', { class: 'empty' }, `No earthquakes listed in the past ${live.usgsWindow}.`)
            : h('ul', { class: 'list', 'data-testid': 'usgs-list' }, ...live.usgs.slice(0, 12).map(quakeRow));
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
      body,
    );
  }

  /** Built once: what is typed into it, and whether it is open, survive every update. */
  function relaysBox() {
    const note = h('p', { class: 'small relays-note', role: 'status', id: 'relays-note' });
    const ta = h('textarea', { 'aria-label': 'Relay URLs, one per line', 'aria-describedby': 'relays-note', spellcheck: 'false' });
    ta.value = ctx.relays.join('\n');
    // Saving reloads the page, so a list with a wrong line is not saved at all: the user sees why first.
    const save = () => {
      const lines = ta.value.split(/\s+/).filter(Boolean);
      const wrong = lines.filter((s) => !/^wss?:\/\/\S/.test(s));
      if (lines.length && !wrong.length) return ctx.saveRelays(lines);
      ta.setAttribute('aria-invalid', 'true');
      note.textContent = wrong.length ? `Relay addresses start with wss://. Fix or remove these lines, then save again: ${wrong.join(', ')}.` : 'Add at least one relay address. Relay addresses start with wss://.';
    };
    const el = h('details', { class: 'relays' }, h('summary', {}, 'Relays'));
    const list = part(el);
    el.append(
      ta,
      note,
      h('p', { class: 'small muted' }, 'Most public Nostr relays work. Tremor events are tagged #tremor: kind 4578 picks, kind 5 retractions, kind 4579 confirmed triggers and kind 34579 heartbeats.'),
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
    parts.stats(statsRow());
    parts.provisional(provisionalCards());
    parts.detail(detailCard());
    parts.detections(detections());
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
