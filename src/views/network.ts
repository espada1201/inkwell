import type { LiveNetwork } from '../app/live';
import { shakeGrid } from '../core/impact';
import { matchUsgs, type UsgsQuake } from '../net/usgs';
import { ago, coord, h, mag } from '../ui/dom';
import type { QuakeMap } from '../ui/map';
import { compareCard } from './compare';

export interface NetworkCtx {
  live: LiveNetwork;
  map: QuakeMap;
  relays: string[];
  saveRelays: (urls: string[]) => void;
}

export function networkView(ctx: NetworkCtx) {
  const { live, map } = ctx;
  let selected: { kind: 'event' | 'usgs'; id: string } | null = null;
  let flewToData = false;
  const root = h('div', { class: 'panel-inner' });
  // Screen readers hear of a new provisional detection once; everything after this is redrawn freely.
  const announcer = h('p', { class: 'sr-only', role: 'alert' });
  root.append(announcer);
  let announced = 0;

  map.onSelect = (kind, id) => {
    selected = { kind, id };
    render();
  };

  function syncMap() {
    const now = Date.now();
    const winMs = live.usgsWindow === 'hour' ? 3600_000 : 86400_000;
    map.setUsgs(live.usgs.map((q) => ({ id: q.id, lat: q.lat, lon: q.lon, mag: q.mag, age: Math.min(1, (now - q.time) / winMs) })));
    // Phones with a pick still being checked: retracted picks leave the list.
    const picking = new Set([...live.picks.values()].filter((p) => now - p.t < 60_000).map((p) => p.node));
    map.setNodes(
      [...live.nodes.values()].map((n) => ({
        id: n.id,
        lat: n.lat,
        lon: n.lon,
        state: !live.isOnline(n, now) ? 'offline' : n.lastTrigger && now - n.lastTrigger < 120_000 ? 'trigger' : picking.has(n.id) ? 'pick' : 'idle',
      })),
    );
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
    map.setWaves(null);
    map.setTruth(null);
    const newest = live.early[0] ?? live.events[live.events.length - 1];
    if (!flewToData && newest) {
      flewToData = true;
      map.fly(newest, 7);
    }
  }

  function quakeRow(q: UsgsQuake) {
    const on = selected?.kind === 'usgs' && selected.id === q.id;
    return h(
      'li',
      {},
      h(
        'button',
        {
          class: 'row',
          'aria-pressed': on ? 'true' : 'false',
          'data-key': `usgs:${q.id}`,
          onclick: () => {
            selected = { kind: 'usgs', id: q.id };
            map.fly(q, 7);
            render();
          },
        },
        h('span', { class: 'badge' }, q.mag === null ? '?' : q.mag.toFixed(1)),
        h('span', { class: 'where' }, q.place),
        h('span', { class: 'when' }, ago(q.time)),
      ),
    );
  }

  function render() {
    const n = live.early.length;
    if (n > announced) announcer.textContent = `${n === 1 ? `Provisional earthquake detection near ${coord(live.early[0].lat, live.early[0].lon)}` : `${n} provisional earthquake detections`}. Waiting for the phones to confirm.`;
    else if (!n) announcer.textContent = '';
    announced = n;
    const onlineNodes = [...live.nodes.values()].filter((n) => live.isOnline(n)).length;
    const st = live.transport.statuses();
    const open = st.filter((s) => s.state === 'open').length;
    const ev = selected?.kind === 'event' ? live.events.find((e) => e.id === selected!.id) : null;
    const uq = selected?.kind === 'usgs' ? live.usgs.find((q) => q.id === selected!.id) : null;

    const detail = ev
      ? (() => {
          const m = matchUsgs(ev, live.usgs);
          return compareCard(
            'Network detection',
            { lat: ev.lat, lon: ev.lon, time: ev.time, mag: ev.mag, nodes: ev.triggers.length, rms: ev.rms },
            m ? { lat: m.quake.lat, lon: m.quake.lon, time: m.quake.time, mag: m.quake.mag, label: 'USGS', url: m.quake.url } : null,
            live.usgsState === 'ok' ? 'No matching USGS event yet. Official solutions can take minutes, or this may be a false alarm.' : 'USGS feed unavailable, cannot cross-check right now.',
          );
        })()
      : uq
        ? h(
            'section',
            { class: 'compare', 'aria-label': 'USGS event' },
            h('header', {}, h('b', {}, `${mag(uq.mag)} · ${uq.place}`), h('a', { href: uq.url, target: '_blank', rel: 'noopener', class: 'small' }, 'USGS ↗')),
            h('p', { class: 'verdict mono small' }, `${coord(uq.lat, uq.lon)} · depth ${uq.depthKm.toFixed(0)} km · ${ago(uq.time)}`),
          )
        : null;

    const usgsBody =
      live.usgsState === 'loading' && !live.usgs.length
        ? h('div', {}, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))
        : live.usgsState === 'error'
          ? h('p', { class: 'empty', role: 'status' }, 'The USGS feed could not be reached. Retrying every two minutes.')
          : live.usgs.length === 0
            ? h('p', { class: 'empty' }, `No earthquakes listed in the past ${live.usgsWindow}.`)
            : h('ul', { class: 'list', 'data-testid': 'usgs-list' }, ...live.usgs.slice(0, 12).map(quakeRow));

    const children = [
      h(
        'div',
        {},
        h('h1', {}, 'Live network'),
        h('p', { class: 'lede' }, 'Phones lying still on tables, everywhere. Their triggers travel over public Nostr relays and are pieced together right here in your browser. No server.'),
      ),
      h(
        'div',
        { class: 'stats', title: 'Phones heard from in the last 10 minutes; triggers and quakes from the last 2 hours' },
        h('div', {}, h('b', { 'data-testid': 'stat-nodes' }, onlineNodes), h('span', {}, 'phones')),
        h('div', {}, h('b', {}, live.triggers.length), h('span', {}, 'triggers')),
        h('div', {}, h('b', { 'data-testid': 'stat-events' }, live.events.length), h('span', {}, 'quakes')),
        h('div', {}, h('b', {}, `${open}/${st.length}`), h('span', {}, 'relays')),
      ),
      ...live.early.map((e) =>
        h(
          'section',
          { class: 'warn-card', 'data-testid': 'provisional' },
          h('header', {}, h('b', {}, 'Provisional detection'), h('span', { class: 'mono' }, ago(e.time))),
          h('p', {}, `${e.triggers.length} phones felt shaking start in a pattern that fits one source near ${coord(e.lat, e.lon)}, and the phones nearby that stayed quiet do not outvote them. Waiting for the phones to confirm.`),
        ),
      ),
      detail ?? '',
      h(
        'section',
        {},
        h('h2', {}, 'Detected by Tremor', h('small', {}, 'last 2 hours')),
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
                    {
                      class: 'row',
                      'aria-pressed': selected?.kind === 'event' && selected.id === e.id ? 'true' : 'false',
                      'data-key': `event:${e.id}`,
                      onclick: () => {
                        selected = { kind: 'event', id: e.id };
                        map.fly(e, 8);
                        render();
                      },
                    },
                    h('span', { class: 'badge ours' }, e.mag === null ? '?' : e.mag.toFixed(1)),
                    h('span', { class: 'where' }, m ? `Matches USGS: ${m.quake.place}` : coord(e.lat, e.lon), h('br'), h('span', { class: 'small muted' }, `${e.triggers.length} phones agreed`)),
                    h('span', { class: 'when' }, ago(e.time)),
                  ),
                );
              }),
            )
          : h(
              'p',
              { class: 'empty', 'data-testid': 'no-events' },
              'No network detections in the past two hours. That is normal: phones only notice strong shaking close by. ',
              h('a', { href: '#replay' }, 'Watch a replay'),
              ' or ',
              h('a', { href: '#sensor' }, 'turn this phone into a sensor'),
              '.',
            ),
      ),
      h(
        'section',
        {},
        h(
          'h2',
          {},
          'Official · USGS',
          h(
            'span',
            { class: 'seg', role: 'group', 'aria-label': 'USGS time window' },
            ...(['hour', 'day'] as const).map((w) =>
              h('button', { 'aria-pressed': live.usgsWindow === w ? 'true' : 'false', onclick: () => live.setUsgsWindow(w) }, `past ${w}`),
            ),
          ),
        ),
        usgsBody,
      ),
      h('p', { class: 'honest' }, 'Community science, not an official warning system. Phones only feel fairly strong shaking, and anyone can publish to public relays. For official alerts use your national seismic service.'),
      relaysBox(),
    ];
    keepFocus(root, () => {
      while (announcer.nextSibling) announcer.nextSibling.remove();
      root.append(...children);
    });
    syncMap();
  }

  function relaysBox() {
    const ta = h('textarea', { 'aria-label': 'Relay URLs, one per line', spellcheck: 'false' }) as HTMLTextAreaElement;
    ta.value = ctx.relays.join('\n');
    return h(
      'details',
      { class: 'relays' },
      h('summary', {}, 'Relays'),
      h(
        'ul',
        { class: 'relay-list' },
        ...live.transport.statuses().map((s) =>
          h('li', {}, h('i', { class: `dot ${s.state === 'open' ? 'ok' : s.state === 'connecting' ? 'warn' : 'bad'}` }), h('span', {}, s.url), h('span', { class: 'muted' }, ` ${s.state} · ↓${s.received}`)),
        ),
      ),
      ta,
      h(
        'p',
        { class: 'small muted' },
        'Most public Nostr relays work. Tremor events are tagged #tremor: kind 4578 picks, kind 5 retractions, kind 4579 confirmed triggers and kind 34579 heartbeats.',
      ),
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            const urls = ta.value.split(/\s+/).map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
            if (urls.length) ctx.saveRelays(urls);
          },
        },
        'Save and reconnect',
      ),
    );
  }

  let queued = false;
  const off = live.on(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const openDetails = root.querySelector('details.relays')?.hasAttribute('open');
      const focusedInPanel = root.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA';
      if (focusedInPanel) return syncMap();
      render();
      if (openDetails) root.querySelector('details.relays')?.setAttribute('open', '');
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

/**
 * Rebuild a panel without losing keyboard focus: the element focused before is found again by
 * its data-key, or else by its tag and text.
 */
function keepFocus(root: HTMLElement, rebuild: () => void) {
  const key = (el: Element) => (el instanceof HTMLElement && el.dataset.key) || `${el.tagName}:${el.textContent}`;
  const was = document.activeElement;
  const k = was && was !== document.body && root.contains(was) ? key(was) : null;
  rebuild();
  if (k === null || root.contains(document.activeElement)) return;
  for (const el of root.querySelectorAll<HTMLElement>(was!.tagName)) if (key(el) === k) return el.focus({ preventScroll: true });
}
