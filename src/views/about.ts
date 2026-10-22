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
      h('li', {}, h('span', {}, h('b', {}, 'Tell at once. '), 'About a second after the shaking reaches it, it publishes a pick: shaking started here, signed with a key made on the phone, location rounded to about a kilometre. It also says which wave it felt. The first, P, shakes the ground up and down; the stronger S wave shakes it side to side, and gravity tells the phone which way is down.')),
      h('li', {}, h('span', {}, h('b', {}, 'Doubt. '), 'Then it checks the shaking against the background from before it began. A rotated phone means someone picked it up, shaking that lasts under a second is a bump or a door, and a train of short knocks is footsteps. Bad picks are withdrawn; good ones are confirmed with their peak shaking.')),
      h('li', {}, h('span', {}, h('b', {}, 'Agree. '), 'Any browser watching the relays groups picks that could be one wavefront and finds the epicentre that best explains their arrival times, and how far off it could be. It only declares a quake if the phones that stayed quiet do not outvote the picks. With picks from a handful of places, nearly every phone close enough to have felt it by now must have; from sixteen places or more, a third is enough, because a weak wave is only noticed by some phones. Phones in one building count as one place, and nothing is declared while phones the wave is still reaching could change the verdict.')),
      h('li', {}, h('span', {}, h('b', {}, 'Check. '), 'Every confirmed detection is compared against the official USGS feed so the network keeps itself honest. Outside the US, USGS may not list quakes below about M4.5.')),
    ),
    h(
      'section',
      { class: 'honest' },
      h('p', {}, h('b', {}, 'What it is not. '), 'Not an official warning system. Phones only feel fairly strong shaking, their clocks are only good to a fraction of a second, and magnitudes are rough: big quakes read low. A sensor phone, or a page set to chime, works only while it stays open on screen. Public relays are open, so anyone could publish fake phones, picks or felt reports. For alerts, on Android turn on Earthquake alerts in Settings under Safety & emergency (the path varies by maker); on the US West Coast, keep Wireless Emergency Alerts on and add the MyShake app; elsewhere, follow your national seismic service.'),
      h('p', {}, h('b', {}, 'Who came first. '), 'The Quake-Catcher Network put sensors in laptops from 2008, and MyShake and Android’s Earthquake Alerts use phones with a company’s servers. Tremor tries the same with no server at all.'),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Privacy'),
      h('p', { class: 'small' }, 'Nothing is sent until you switch sharing on and set a location, or report shaking you felt. Locations are snapped to a 0.01° grid on your phone and again on every receiver. A felt report carries that rough location too, for anyone watching the relays to see. Your node key lives only in this browser. A town you type is looked up in a list that comes with the page (place names from GeoNames, CC BY 4.0), so it is never sent anywhere.'),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Open protocol'),
      h('p', { class: 'small' }, 'Ordinary signed Nostr events tagged #tremor: picks are kind 4578, retractions kind 5, confirmed reports kind 4579, heartbeats kind 34579 and felt reports kind 4580. Most carry a small JSON body; a retraction just names its reason. Anyone can build their own viewer or detector on the same events. ', h('a', { href: 'https://github.com/espada1201/inkwell', target: '_blank', rel: 'noopener' }, 'The code is open too ↗')),
    ),
  );
  return { el, dispose: () => {} };
}
