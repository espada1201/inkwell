import type { SensorNode } from '../app/sensor';
import type { RejectReason } from '../core/sensor';
import { coord, h } from '../ui/dom';
import { drawTrace } from '../ui/trace';

const REASONS: Record<RejectReason, string> = {
  handling: 'phone moved',
  impulse: 'bump or door slam',
  footsteps: 'footsteps',
  interrupted: 'sensor paused before it could check',
};

const STATE_COPY: Record<SensorNode['state'], [string, string]> = {
  idle: ['Ready', 'Lay this phone flat on a solid surface near the floor, plugged in, then start the sensor.'],
  unsupported: ['No motion sensor', 'This browser does not expose an accelerometer. Open Tremor on a phone (over HTTPS) to become a node.'],
  denied: ['Motion access denied', 'Allow motion and orientation access for this site in your browser settings, then try again.'],
  'no-data': ['No motion data', 'The browser allowed access but no readings arrived. Desktop computers usually have no accelerometer: try a phone.'],
  warming: ['Warming up', 'Learning this spot’s background noise. Keep the phone still.'],
  listening: ['Listening', 'Watching for strong shaking. This phone recognises most footsteps, bumps and handling, and withdraws them.'],
};

export function sensorView(s: SensorNode) {
  const root = h('div', { class: 'sensor-inner' });
  const canvas = h('canvas', { class: 'trace', role: 'img', 'aria-label': 'Live accelerometer trace' });
  const meterFill = h('i');
  const meterThr = h('b');
  const ratioText = h('span', { class: 'mono small muted' });
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
    ratioText.textContent = d ? `STA/LTA ${d.ratio.toFixed(1)} · threshold ${d.threshold.toFixed(1)}` : 'STA/LTA —';
    raf = dimmed || document.hidden ? 0 : requestAnimationFrame(loop);
  }

  function locationCard() {
    const lat = h('input', { inputmode: 'decimal', placeholder: 'lat', 'aria-label': 'Latitude' }) as HTMLInputElement;
    const lon = h('input', { inputmode: 'decimal', placeholder: 'lon', 'aria-label': 'Longitude' }) as HTMLInputElement;
    const msg = h('p', { class: 'small muted', role: 'status' });
    if (s.location) {
      lat.value = String(s.location.lat);
      lon.value = String(s.location.lon);
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
            const a = parseFloat(lat.value);
            const b = parseFloat(lon.value);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) s.setLocation({ lat: a, lon: b });
            else msg.textContent = 'Latitude must be within ±90 and longitude within ±180.';
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
    const join = h('input', { type: 'checkbox', checked: s.joined, onchange: (e: Event) => s.setJoined((e.target as HTMLInputElement).checked) });
    left.replaceChildren(
      h('div', { class: 'state-line' }, h('i', { class: pulse }), h('h1', { 'data-testid': 'sensor-state' }, title)),
      h('p', { class: 'muted' }, copy),
      canvas,
      h('div', { class: 'meter', 'aria-hidden': 'true' }, meterFill, meterThr),
      ratioText,
      h(
        'div',
        { class: 'transport' },
        running
          ? h('button', { class: 'btn', onclick: () => s.stop() }, 'Stop sensor')
          : h('button', { class: 'btn primary', 'data-testid': 'start', onclick: () => s.start() }, 'Start sensor'),
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
                    ? h('span', { class: 'tag trig' }, `TRIGGER ${l.out.pga.toFixed(2)} m/s² · ${l.out.phase} wave${l.published ? ' · sent' : ' · not sent'}`)
                    : h('span', { class: 'tag rej' }, `${l.published ? 'withdrawn' : 'ignored'}: ${REASONS[l.out.reason]}`),
                ),
              ),
            )
          : h('p', { class: 'small muted' }, 'Nothing yet. Try tapping the table: the phone should notice it, and its verdict appears here 15–30 s later.'),
      ),
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
          s.canPublish ? 'On. Shaking goes out at once as a pick, then is confirmed or withdrawn, plus a heartbeat every minute. All signed with this phone’s key.' : !s.joined ? 'Off. Nothing leaves this phone.' : 'Set a location to start sharing.',
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
          h('dd', {}, s.detector ? `${(s.noise * 1000).toFixed(1)} mm/s²` : '—'),
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
  root.addEventListener('focusout', () => setTimeout(() => !typing() && render()));
  const off = s.on(() => !typing() && render());
  render();
  loop();
  return { el: root, dispose: () => (off(), cancelAnimationFrame(raf)) };
}
