import type { Place } from '../app/near';
import { parseLatLon, type LatLon } from '../core/geo';
import { h } from '../ui/dom';

/** Asks where you are, roughly: by the browser's location or typed coordinates. `then` follows once it is set. */
export function placeForm(place: Place, then: () => void) {
  const msg = h('p', { class: 'small', role: 'status' });
  const typed = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '37.80, -122.27' });
  const set = (p: LatLon) => {
    place.setLocation(p);
    // The browser can answer after the form has gone.
    if (form.isConnected) then();
  };
  const locate = () => {
    if (!navigator.geolocation) return void (msg.textContent = 'This browser cannot tell where it is. Type rough coordinates instead.');
    msg.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (p) => set({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => (msg.textContent = 'No location given. You can type rough coordinates instead.'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const at = parseLatLon(typed.value);
    if (at) return set(at);
    typed.setAttribute('aria-invalid', 'true');
    msg.textContent = 'Type a latitude and a longitude, with a point for decimals, for example 37.80, -122.27.';
  };
  const form = h(
    'div',
    { class: 'stack' },
    h('p', {}, 'Where are you, roughly? Tremor snaps it to about 1 km and keeps it in this browser.'),
    h('button', { class: 'btn', 'data-key': 'locate', onclick: locate }, 'Use my approximate location'),
    h('form', { class: 'place-form', onsubmit: submit }, h('label', {}, 'Or type latitude, longitude', typed), h('button', { class: 'btn', type: 'submit' }, 'Set')),
    msg,
  );
  return form;
}
