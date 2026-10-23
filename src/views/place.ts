import type { Place } from '../app/near';
import { parseLatLon, type LatLon } from '../core/geo';
import { findTowns, parseTowns, townLabel, type Town } from '../core/places';
import { h } from '../ui/dom';
import { coord } from '../ui/format';

let towns: Promise<Town[]> | null = null;
/** The town list is fetched the first time someone types a name, not with the page. */
export const loadTowns = () =>
  (towns ??= import('../data/places.tsv?raw').then(
    (m) => parseTowns(m.default),
    (e) => {
      // Offline, or a page older than the site: try again on the next press.
      towns = null;
      throw e;
    },
  ));
const MAX_CHOICES = 6;

/** Asks where you are, roughly: by the browser's location, a town's name or typed coordinates. `then` follows once it is set. */
export function placeForm(place: Place, then: () => void) {
  const msg = h('p', { class: 'small', role: 'status' });
  const choices = h('div', { class: 'choices' });
  const typed = h('input', { autocomplete: 'off', placeholder: 'Fresno, CA  or  36.74, -119.79' });
  // Nothing happens until Set or Enter: the button stands out while the box holds text that has not been used.
  const setButton = h('button', { class: 'btn', type: 'submit' }, 'Set');
  typed.addEventListener('input', () => setButton.classList.toggle('primary', typed.value.trim() !== ''));
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
    let found;
    try {
      found = findTowns(await loadTowns(), text);
    } catch {
      msg.textContent = 'The list of towns could not be loaded. Try again, or type coordinates.';
      return;
    }
    // The form may have gone while the list loaded.
    if (!form.isConnected) return;
    if (found.length === 1) return set(found[0], townLabel(found[0]));
    if (!found.length) {
      typed.setAttribute('aria-invalid', 'true');
      msg.textContent = `No town called “${text.trim()}” in Tremor’s list, which has towns of over 15,000 people (5,000 in the US), spelled in Latin letters. Try a bigger town nearby, or coordinates.`;
      return;
    }
    const shown = found.slice(0, MAX_CHOICES);
    msg.textContent = found.length > MAX_CHOICES ? `${found.length} towns match; here are the ${MAX_CHOICES} biggest. Add a state or country after a comma to narrow it down.` : `${found.length} towns match. Which one?`;
    const twice = (t: Town) => shown.filter((u) => townLabel(u) === townLabel(t)).length > 1;
    choices.replaceChildren(...shown.map((t) => h('button', { class: 'btn', type: 'button', onclick: () => set(t, townLabel(t)) }, twice(t) ? `${townLabel(t)} (${coord(t.lat, t.lon)})` : townLabel(t))));
    choices.querySelector('button')?.focus();
  };
  const form = h(
    'div',
    { class: 'stack' },
    h('p', {}, 'Where are you, roughly? Tremor snaps it to about 1 km and keeps it in this browser.'),
    h('button', { class: 'btn', 'data-key': 'locate', onclick: locate }, 'Use my approximate location'),
    h('form', { class: 'place-form', onsubmit: submit }, h('label', {}, 'Or type a town, or latitude, longitude', typed), setButton),
    msg,
    choices,
  );
  return form;
}
