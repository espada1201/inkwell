import type { Place } from '../app/near';
import { parseLatLon, type LatLon } from '../core/geo';
import { findTowns, parseTowns, townLabel, type Town } from '../core/places';
import { h } from '../ui/dom';

let towns: Promise<Town[]> | null = null;
/** The town list is fetched the first time someone types a name, not with the page. */
const loadTowns = () => (towns ??= import('../data/places.tsv?raw').then((m) => parseTowns(m.default)));

/** Asks where you are, roughly: by the browser's location, a town's name or typed coordinates. `then` follows once it is set. */
export function placeForm(place: Place, then: () => void) {
  const msg = h('p', { class: 'small', role: 'status' });
  const choices = h('div', { class: 'choices' });
  const typed = h('input', { autocomplete: 'off', placeholder: 'Fresno, CA  or  36.74, -119.79' });
  const set = (p: LatLon, name: string | null = null) => {
    place.setLocation(p, name);
    // The browser can answer after the form has gone.
    if (form.isConnected) then();
  };
  const locate = () => {
    if (!navigator.geolocation) return void (msg.textContent = 'This browser cannot tell where it is. Type a town instead.');
    msg.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (p) => set({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => (msg.textContent = 'No location given. You can type a town instead.'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    choices.replaceChildren();
    typed.removeAttribute('aria-invalid');
    const text = typed.value;
    const at = parseLatLon(text);
    if (at) return set(at);
    if (/^[\s\d.,+-]*$/.test(text)) {
      typed.setAttribute('aria-invalid', 'true');
      msg.textContent = 'Type a town, or a latitude and a longitude with a point for decimals, for example 37.80, -122.27.';
      return;
    }
    msg.textContent = 'Looking it up…';
    const found = findTowns(await loadTowns(), text);
    if (found.length === 1) return set(found[0], townLabel(found[0]));
    if (!found.length) {
      typed.setAttribute('aria-invalid', 'true');
      msg.textContent = `No town called “${text.trim()}” in Tremor’s list, which has towns of over 15,000 people (5,000 in the US). Try a bigger town nearby, or coordinates.`;
      return;
    }
    msg.textContent = `${found.length} towns match. Which one?`;
    choices.replaceChildren(...found.map((t) => h('button', { class: 'btn', type: 'button', onclick: () => set(t, townLabel(t)) }, townLabel(t))));
    choices.querySelector('button')?.focus();
  };
  const form = h(
    'div',
    { class: 'stack' },
    h('p', {}, 'Where are you, roughly? Tremor snaps it to about 1 km and keeps it in this browser.'),
    h('button', { class: 'btn', 'data-key': 'locate', onclick: locate }, 'Use my approximate location'),
    h('form', { class: 'place-form', onsubmit: submit }, h('label', {}, 'Or type a town, or latitude, longitude', typed), h('button', { class: 'btn', type: 'submit' }, 'Set')),
    msg,
    choices,
  );
  return form;
}
