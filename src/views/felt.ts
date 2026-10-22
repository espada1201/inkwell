import type { LiveNetwork } from '../app/live';
import type { Place } from '../app/near';
import { FELT_EVERY_MS, type Felt } from '../core/felt';
import { loadIdentity } from '../net/identity';
import { reach } from '../net/transport';
import { matchFelt } from '../net/usgs';
import { h } from '../ui/dom';
import { INTENSITY_WORDS, clock, coord } from '../ui/format';
import { placeForm } from './place';

/** What each level feels like, weak to very strong. */
const FEELS = ['Barely felt, like a truck passing', 'Windows, doors and dishes rattled', 'Felt by everyone; small things fell over', 'Hard to stand; furniture moved', 'Hard to stay on your feet; buildings damaged'];
/** USGS "Did You Feel It?", for when no listed quake matches. */
const DYFI = 'https://earthquake.usgs.gov/data/dyfi/';

/**
 * "I felt it": one question with five levels, one tap to send. It needs no sensor and no motion
 * permission, and takes the location that "Shaking near you?" keeps, asking for one if none is set.
 */
export function feltDialog(live: LiveNetwork, place: Place) {
  const body = h('div', { class: 'stack' });
  const el = h('dialog', { class: 'felt', 'aria-labelledby': 'felt-title' }, h('h2', { id: 'felt-title' }, 'I felt it'), body, h('form', { method: 'dialog' }, h('button', { class: 'btn' }, 'Close')));

  /** A report is out: what it said, and where else to tell. */
  function sent(f: Felt) {
    const m = matchFelt(f, live.usgs);
    const out = reach(live.transport.statuses()) === 'open' ? 'It is on its way to the relays.' : 'No relay is connected yet: it goes out once one is, while this page stays open.';
    return [
      h('p', { role: 'status' }, `Thanks. You reported ${INTENSITY_WORDS[f.lvl]} shaking at ${clock(f.t)}. ${out} You can report again from ${clock(f.t + FELT_EVERY_MS)}.`),
      h('a', { class: 'btn', href: m ? `${m.quake.url}/tellus` : DYFI, target: '_blank', rel: 'noopener' }, 'Tell USGS too ↗'),
    ];
  }

  function show() {
    const me = loadIdentity();
    const you = place.location;
    const last = live.lastFelt(me.pubkey, Date.now());
    if (!you) body.replaceChildren(placeForm(place, show));
    else if (last) body.replaceChildren(...sent(last));
    else
      body.replaceChildren(
        h('p', { id: 'felt-q' }, 'How strong was the shaking where you are?'),
        h(
          'div',
          { class: 'levels', role: 'group', 'aria-labelledby': 'felt-q' },
          ...FEELS.map((d, i) =>
            h(
              'button',
              {
                class: 'level',
                onclick: () => {
                  live.reportFelt(me, you, i + 1);
                  show();
                },
              },
              h('b', {}, INTENSITY_WORDS[i + 1]),
              h('span', {}, d),
            ),
          ),
        ),
        h('p', { class: 'small muted' }, `Your report carries your rough location, ${coord(you.lat, you.lon)}, and anyone watching the relays can see it.`),
      );
    // What had focus is gone; opening the dialog focuses its first control by itself.
    body.querySelector<HTMLElement>('button, a')?.focus();
  }

  return {
    el,
    open: () => {
      show();
      el.showModal();
    },
  };
}
