import type { LiveNetwork } from '../app/live';
import { reachKm, type SensorNode, type Verdict } from '../app/sensor';
import { distanceKm, parseLatLon, type LatLon } from '../core/geo';
import { h, keepFocus } from '../ui/dom';
import { WITHDRAWN, coord, intensityWord, mag, many } from '../ui/format';
import { drawTrace } from '../ui/trace';

const STIRRING = 2.5;

const NEAR_KM = 25;

const VERDICTS: Record<Verdict, [label: string, cls: string]> = { felt: ['felt', 'tag trig'], missed: ['missed', 'tag rej'], 'too weak': ['too weak here, as expected', 'muted'] };

const about = (km: number) => (km < 20 ? Math.max(1, Math.round(km)) : Math.round(km / 10) * 10);

function duration(ms: number) {
  const m = Math.floor(ms / 60_000);
  return !ms ? 'none' : m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const STATE_COPY: Record<SensorNode['state'], [string, string]> = {
  idle: ['Ready', 'Lay this phone flat on a solid surface near the floor, plugged in, then start the sensor.'],
  unsupported: ['No motion sensor', 'This browser does not expose an accelerometer. Open Tremor on a phone (over HTTPS) to become a node.'],
  denied: ['Motion access denied', 'Allow motion and orientation access for this site in your browser settings, then try again.'],
  'no-data': ['No motion data', 'The browser allowed access but no readings arrived. Desktop computers usually have no accelerometer: try a phone.'],
  warming: ['Warming up', 'Learning this spot’s background noise. Keep the phone still.'],
  listening: ['Listening', 'Watching for strong shaking. This phone recognises most footsteps, bumps and handling, and withdraws them.'],
};

export function sensorView(s: SensorNode, live: LiveNetwork) {
  const root = h('div', { class: 'sensor-inner' });
  const canvas = h('canvas', { class: 'trace', role: 'img', 'aria-label': 'Live accelerometer trace' });
  const meterFill = h('i');
  const meterThr = h('b');
  const meterWord = h('strong', { 'data-testid': 'meter-word' });
  const ratioText = h('span', { class: 'mono small muted' });
  const background = h('dd', { 'data-testid': 'background' });
  const feel = h('section', { class: 'card', 'data-testid': 'can-feel' });
  let shown = -Infinity;
  const lat = h('input', { inputmode: 'decimal', placeholder: 'lat', 'aria-label': 'Latitude' });
  const lon = h('input', { inputmode: 'decimal', placeholder: 'lon', 'aria-label': 'Longitude' });
  let filled: LatLon | null | undefined;
  const left = h('div', { style: 'display:grid;gap:14px;align-content:start' });
  const right = h('div', { style: 'display:grid;gap:14px;align-content:start' });
  let dimmed = false;
  let raf = 0;

  function loop() {
    drawTrace(canvas, s);
    const d = s.detector;
    const scale = (v: number) => Math.min(100, (Math.log10(1 + v) / Math.log10(1 + 50)) * 100);
    meterFill.style.width = `${d ? scale(d.ratio) : 0}%`;
    meterThr.style.left = `${d ? scale(d.threshold) : 0}%`;
    meterWord.textContent = !d || d.warmingUp ? '' : d.overTrigger ? 'Shaking' : d.ratio >= STIRRING ? 'Something moving' : 'Quiet';
    ratioText.textContent = d ? `STA/LTA ${d.ratio.toFixed(1)} · threshold ${d.threshold.toFixed(1)}` : 'STA/LTA —';
    if (performance.now() - shown > 1000) {
      shown = performance.now();
      background.textContent = !d ? '—' : d.warmingUp ? 'learning…' : `${(d.background * 1000).toFixed(1)} mm/s²`;
      const next = canFeel();
      if (next.textContent !== feel.textContent) feel.replaceChildren(...next.childNodes);
    }
    raf = dimmed || document.hidden ? 0 : requestAnimationFrame(loop);
  }

  function canFeel() {
    const d = s.detector;
    const here = s.location;
    const { session, week } = s.listened();
    const reach = (m: number, pga: number) => {
      const km = reachKm(m, pga);
      return km ? `an M${m} within about ${about(km)} km` : `no M${m}, even right below`;
    };
    const quakes = s.nearbyQuakes(live.usgs);
    const phones = here ? [...live.nodes.values()].filter((n) => n.id !== s.pubkey && live.isOnline(n) && distanceKm(n, here) <= NEAR_KM).length : 0;
    return h(
      'div',
      {},
      h('h2', {}, 'What this phone can feel'),
      h('p', { 'data-testid': 'reach' }, !d ? 'Start the sensor to see how far away it would notice a quake.' : d.warmingUp ? 'Learning this spot’s background first…' : `Would notice ${reach(4, d.noticesPga)} and ${reach(5, d.noticesPga)}.`),
      h('p', {}, `Listening time: ${duration(session)} this session, ${duration(week)} this week.`),
      !here
        ? h('p', { class: 'small muted' }, 'Set a location to see the phones and quakes near you.')
        : h('p', { 'data-testid': 'neighbours' }, phones ? `Heard from ${many(phones, 'other phone')} listening within ${NEAR_KM} km.` : `No other phones heard listening within ${NEAR_KM} km.`),
      !here || !d
        ? null
        : live.usgsState === 'loading'
          ? h('p', { class: 'small muted' }, 'Loading quakes from USGS…')
          : live.usgsState === 'error'
            ? h('p', { class: 'small muted' }, 'The USGS feed could not be reached, so quakes nearby are unknown for now.')
            : quakes.length
              ? h(
                  'ul',
                  { class: 'log', 'data-testid': 'nearby-quakes' },
                  ...quakes.map((q) => h('li', {}, h('span', {}, `${mag(q.quake.mag)} · ${q.quake.place} · about ${about(q.km)} km away`), h('span', { class: VERDICTS[q.verdict][1] }, VERDICTS[q.verdict][0]))),
                )
              : h('p', { class: 'small muted' }, 'No USGS quake since it began listening was strong enough here to register.'),
      h('p', { class: 'small muted' }, 'These estimates are rough: they come from a simple model of how shaking fades with distance, and this phone’s background now. Listening time is kept in this browser only.'),
    );
  }

  function locationCard() {
    const msg = h('p', { class: 'small muted', role: 'status' });
    if (s.location !== filled) {
      filled = s.location;
      lat.value = s.location ? String(s.location.lat) : '';
      lon.value = s.location ? String(s.location.lon) : '';
    }
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Location'),
      h('p', { 'data-testid': 'loc' }, s.location ? coord(s.location.lat, s.location.lon) : 'Not set'),
      h('p', { class: 'small muted' }, 'Snapped to a 1 km grid before it ever leaves this phone. Your street is never shared.'),
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            if (!navigator.geolocation) return void (msg.textContent = 'Geolocation is unavailable. Enter coordinates instead.');
            msg.textContent = 'Locating…';
            navigator.geolocation.getCurrentPosition(
              (p) => s.setLocation({ lat: p.coords.latitude, lon: p.coords.longitude }),
              () => (msg.textContent = 'Location refused. You can type approximate coordinates instead.'),
              { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
            );
          },
        },
        'Use my approximate location',
      ),
      h(
        'form',
        {
          class: 'inputs',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const at = parseLatLon(`${lat.value}, ${lon.value}`);
            if (at) s.setLocation(at);
            else msg.textContent = 'Type a number in each box, with a point for decimals: latitude from −90 to 90, longitude from −180 to 180, like 37.77 and -122.42.';
          },
        },
        lat,
        lon,
        h('button', { class: 'btn', type: 'submit' }, 'Set'),
      ),
      msg,
    );
  }

  function render() {
    const [title, copy] = STATE_COPY[s.state];
    const running = s.state === 'warming' || s.state === 'listening';
    const pulse = s.state === 'listening' ? 'pulse live' : running ? 'pulse warn' : 'pulse';
    const join = h('input', { type: 'checkbox', 'data-key': 'join', checked: s.joined, onchange: (e: Event) => s.setJoined((e.target as HTMLInputElement).checked) });
    left.replaceChildren(
      h('div', { class: 'state-line' }, h('i', { class: pulse }), h('h1', { 'data-testid': 'sensor-state' }, title)),
      h('p', { class: 'muted' }, copy),
      canvas,
      h('div', { class: 'meter', 'aria-hidden': 'true' }, meterFill, meterThr),
      h('div', {}, meterWord, ' ', ratioText),
      h(
        'div',
        { class: 'transport' },
        running
          ? h('button', { class: 'btn', 'data-key': 'run', onclick: () => s.stop() }, 'Stop sensor')
          : h('button', { class: 'btn primary', 'data-key': 'run', 'data-testid': 'start', onclick: () => s.start() }, 'Start sensor'),
        running ? h('button', { class: 'btn', onclick: () => dim(true) }, 'Dim screen') : null,
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'What this phone felt'),
        s.log.length
          ? h(
              'ul',
              { class: 'log', 'data-testid': 'sensor-log' },
              ...s.log.map((l) =>
                h(
                  'li',
                  {},
                  h('span', {}, new Date(l.out.t).toLocaleTimeString()),
                  l.out.kind === 'trigger'
                    ? h('span', { class: 'tag trig' }, `Confirmed shaking: ${intensityWord(l.out.pga)}, ${l.out.pga.toFixed(2)} m/s² · ${l.out.phase} wave${l.published ? ' · sent' : ' · not sent'}`)
                    : h('span', { class: 'tag rej' }, `${l.published ? 'withdrawn' : 'ignored'}: ${WITHDRAWN[l.out.reason]}`),
                ),
              ),
            )
          : h('p', { class: 'small muted' }, 'Nothing yet. Try tapping the table: the phone should notice it, and its verdict appears here 15–30 s later.'),
      ),
      feel,
    );
    right.replaceChildren(
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Network'),
        h('label', { class: 'switch' }, join, h('span', {}, 'Share with the Tremor network')),
        h(
          'p',
          { class: 'small muted', 'data-testid': 'publish-note' },
          s.canPublish ? 'On. Shaking goes out as a pick within about a second, then is confirmed or withdrawn 15–30 s later, plus a heartbeat every minute. All of it is signed with this phone’s key.' : !s.joined ? 'Off. Nothing leaves this phone.' : 'Set a location to start sharing.',
        ),
      ),
      locationCard(),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Instrument'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Node key'),
          h('dd', { title: s.pubkey }, `${s.pubkey.slice(0, 8)}…${s.pubkey.slice(-4)}`),
          h('dt', {}, 'Sample rate'),
          h('dd', {}, s.fs ? `${s.fs} Hz` : '—'),
          h('dt', {}, 'Background'),
          background,
          h('dt', {}, 'Screen lock'),
          h('dd', {}, s.wakeLock === 'on' ? 'kept awake' : s.wakeLock === 'unsupported' ? 'not supported' : 'off'),
          h('dt', {}, 'Battery'),
          h('dd', {}, s.battery ? `${Math.round(s.battery.level * 100)}%${s.battery.charging ? ' · charging' : ' · plug me in'}` : '—'),
        ),
      ),
      h('p', { class: 'small muted' }, 'Keep this tab open and in front. Browsers pause sensors in background tabs. Old phones make ideal permanent nodes.'),
    );
  }

  function dim(on: boolean) {
    dimmed = on;
    root.querySelector('.dim')?.remove();
    if (on) {
      const b = h('button', { class: 'dim', onclick: () => dim(false) }, 'Tremor is listening · tap to wake');
      root.append(b);
      b.focus();
    } else if (!raf) loop();
  }

  root.append(left, right);
  // Don't rebuild the form under someone's fingers; catch up when they leave the field.
  const typing = () => root.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT' && (document.activeElement as HTMLInputElement).type !== 'checkbox';
  let behind = false;
  const redraw = () => {
    behind = typing();
    if (!behind) keepFocus(root, render);
  };
  root.addEventListener('focusout', () => setTimeout(() => behind && redraw()));
  const off = s.on(redraw);
  render();
  loop();
  return { el: root, dispose: () => (off(), cancelAnimationFrame(raf)) };
}
