import { h } from '../ui/dom';

export function aboutView() {
  const el = h(
    'div',
    { class: 'panel-inner' },
    h('div', {}, h('h1', {}, 'Old phones as civic infrastructure'), h('p', { class: 'lede' }, 'Every smartphone carries an accelerometer good enough to feel a strong earthquake. Tremor turns idle phones into a seismic network that needs no company, no server and no account.')),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, h('span', {}, h('b', {}, 'Feel. '), 'The phone samples its accelerometer, strips out gravity, and runs an STA/LTA trigger, the same short-term over long-term average test used by real seismometers.')),
      h('li', {}, h('span', {}, h('b', {}, 'Doubt. '), 'Before telling anyone, it checks the shaking: phone rotated means someone picked it up, under a second is a bump or a door, a train of short knocks is footsteps.')),
      h('li', {}, h('span', {}, h('b', {}, 'Tell. '), 'Surviving triggers are signed with a key made on the phone and published to public Nostr relays, with location rounded to about a kilometre.')),
      h('li', {}, h('span', {}, h('b', {}, 'Agree. '), 'Any browser watching the relays groups triggers that could be one wave (no faster than P-waves travel), then finds the epicentre that best explains the arrival times.')),
      h('li', {}, h('span', {}, h('b', {}, 'Check. '), 'Every detection is compared against the official USGS feed so the network keeps itself honest.')),
    ),
    h(
      'section',
      { class: 'honest' },
      h('p', {}, h('b', {}, 'What it is not. '), 'Not an earthquake warning system. Phones only detect strong shaking close by, clocks are only accurate to a fraction of a second, and magnitudes are rough (±0.5–1). Public relays are open, so a determined person could publish fake triggers. Use official alerts from your national seismic service.'),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Privacy'),
      h('p', { class: 'small' }, 'Nothing is sent until you switch sharing on and set a location. Locations are snapped to a 0.01° grid on your phone and again on every receiver. Your node key lives only in this browser.'),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Open protocol'),
      h('p', { class: 'small' }, 'Triggers are Nostr kind 4579 and heartbeats kind 34579, tagged #tremor, with a small JSON body. Anyone can build their own viewer or detector on the same events.'),
    ),
  );
  return { el, dispose: () => {} };
}
