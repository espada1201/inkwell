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
      h('li', {}, h('span', {}, h('b', {}, 'Tell at once. '), 'Within half a second it publishes a pick: shaking started here, signed with a key made on the phone, location rounded to about a kilometre. It also says which wave it felt. The first, P, shakes the ground up and down; the stronger S wave shakes it side to side, and gravity tells the phone which way is down.')),
      h('li', {}, h('span', {}, h('b', {}, 'Doubt. '), 'Then it checks the shaking. Phone rotated means someone picked it up, under a second is a bump or a door, a train of short knocks is footsteps. Bad picks are withdrawn; good ones are confirmed with their peak shaking.')),
      h('li', {}, h('span', {}, h('b', {}, 'Agree. '), 'Any browser watching the relays groups picks that could be one wavefront and finds the epicentre that best explains their arrival times. It only declares a quake if the phones that stayed quiet do not outvote the picks. With a handful of picks, nearly every phone close enough to have felt it by now must have; with sixteen or more, a third is enough, because a weak wave is only noticed by some phones.')),
      h('li', {}, h('span', {}, h('b', {}, 'Check. '), 'Every confirmed detection is compared against the official USGS feed so the network keeps itself honest.')),
    ),
    h(
      'section',
      { class: 'honest' },
      h('p', {}, h('b', {}, 'What it is not. '), 'Not an official warning system. Phones only feel fairly strong shaking, their clocks are only good to a fraction of a second, and magnitudes are rough (±0.5–1). Public relays are open, so a determined person could publish fake picks. Use official alerts from your national seismic service.'),
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
      h('p', { class: 'small' }, 'Ordinary signed Nostr events tagged #tremor: picks are kind 4578, retractions kind 5, confirmed triggers kind 4579 and heartbeats kind 34579. Most carry a small JSON body; a retraction just names its reason. Anyone can build their own viewer or detector on the same events.'),
    ),
  );
  return { el, dispose: () => {} };
}
