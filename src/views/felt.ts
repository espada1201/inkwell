import type { LiveNetwork } from '../app/live';
import type { Place } from '../app/near';
import { FELT_EVERY_MS, type Felt } from '../core/felt';
import { reach } from '../net/transport';
import { matchFelt } from '../net/usgs';
import { h } from '../ui/dom';
import { INTENSITY_WORDS, clock, coord } from '../ui/format';

/** A time with its zone, since other screens give UTC. */
const zoned = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
import { placeForm } from './place';

const FEELS = ['Barely felt, like a truck passing', 'Windows, doors and dishes rattled', 'Felt by everyone; small things fell over', 'Hard to stand; furniture moved', 'Hard to stay on your feet; buildings damaged'];
const DYFI = 'https://earthquake.usgs.gov/data/dyfi/';

/**
 * "I felt it": one question with five levels, one tap to send. It needs no sensor and no motion
 * permission, and takes the location that "Shaking near you?" keeps, asking for one if none is set.
 */
/** How long ago the shaking was, in minutes; reports may be up to an hour old. */
const WHEN = [0, 5, 15, 30];

export function feltDialog(live: LiveNetwork, place: Place, me: { sk: Uint8Array; pubkey: string }) {
  const body = h('div', { class: 'stack' });
  const el = h('dialog', { class: 'felt', 'aria-labelledby': 'felt-title' }, h('h2', { id: 'felt-title' }, 'I felt it'), body, h('form', { method: 'dialog' }, h('button', { class: 'btn' }, 'Close')));
  // A press on the dimmed page around the dialog closes it, as Escape does. The dialog's own padding is
  // the dialog too, and a drag that starts inside and ends outside is not a press outside.
  const outside = (e: MouseEvent) => {
    const r = el.getBoundingClientRect();
    return e.target === el && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  let pressedOutside = false;
  el.addEventListener('pointerdown', (e) => (pressedOutside = outside(e)));
  el.addEventListener('click', (e) => {
    if (pressedOutside && outside(e)) el.close();
    pressedOutside = false;
  });
  let ago = 0;
  /** The report just sent, and when: one about earlier shaking still counts as just sent. */
  let last: { f: Felt; at: number } | null = null;

  function sent(f: Felt, at: number) {
    const m = matchFelt(f, live.usgs);
    const out = reach(live.transport.statuses()) === 'open' ? 'It is on its way to the public relays that carry Tremor’s reports.' : 'No relay is connected yet: it goes out once one is, while this page stays open.';
    return [
      h('p', { role: 'status' }, `Thanks. You reported ${INTENSITY_WORDS[f.lvl]} shaking at ${zoned(f.t)}. ${out} You can report again from ${clock(Math.ceil((Math.max(f.t, at) + FELT_EVERY_MS) / 60_000) * 60_000)}.`),
      h('a', { class: 'btn', href: m ? `${m.quake.url}/tellus` : DYFI, target: '_blank', rel: 'noopener' }, 'Tell USGS too ↗'),
    ];
  }

  function show() {
    const you = place.location;
    const now = Date.now();
    const recent = last && now - last.at < FELT_EVERY_MS ? last : null;
    const earlier = live.lastFelt(me.pubkey, now);
    if (!you) body.replaceChildren(placeForm(place, show));
    else if (recent ?? earlier) body.replaceChildren(...(recent ? sent(recent.f, recent.at) : sent(earlier!, earlier!.t)));
    else {
      const refused = h('p', { class: 'small', role: 'status' });
      body.replaceChildren(
        h('p', { id: 'felt-when' }, 'When was it?'),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-labelledby': 'felt-when' },
          ...WHEN.map((m) =>
            h(
              'button',
              {
                'aria-pressed': String(ago === m),
                onclick: (e: Event) => {
                  ago = m;
                  for (const b of (e.currentTarget as HTMLElement).parentElement!.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
                },
              },
              m ? `${m} min ago` : 'Just now',
            ),
          ),
        ),
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
                  const t = Date.now() - ago * 60_000;
                  const ok = live.reportFelt(me, you, i + 1, t);
                  const f = live.lastFelt(me.pubkey, t)!;
                  // Only one report every ten minutes of shaking: an earlier time can land on one already sent.
                  if (!ok) return void (refused.textContent = `You already reported ${INTENSITY_WORDS[f.lvl]} shaking at ${zoned(f.t)}, within ten minutes of that time, so this was not sent. Pick another time, or close.`);
                  last = { f, at: Date.now() };
                  show();
                },
              },
              h('b', {}, INTENSITY_WORDS[i + 1]),
              h('span', {}, d),
            ),
          ),
        ),
        refused,
        h('p', { class: 'small muted' }, `Your report carries your rough location, ${coord(you.lat, you.lon)}, and anyone watching the relays can see it.`),
      );
    }
    // What had focus is gone; opening the dialog focuses its first control by itself.
    body.querySelector<HTMLElement>('button, a')?.focus();
  }

  return {
    el,
    open: () => {
      ago = 0;
      show();
      el.showModal();
    },
  };
}
