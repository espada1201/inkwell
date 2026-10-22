import type { LiveNetwork } from '../app/live';
import { h } from '../ui/dom';
import { NEAR_MS, nearYou, type Place } from './network';

/** What every chime says, on the page and in the notification. */
const CHIME_TEXT = 'Shaking reported near you. Not an official warning.';
/**
 * Light shaking, which people indoors notice. Weaker shaking, mostly from the small quakes close
 * by that USGS lists all day in active places, is listed on the card but does not chime.
 */
const CHIME_LEVEL = 2;
/** Older shaking is not news. USGS lists quakes abroad up to about 20 minutes after them. */
const RECENT_MS = 30 * 60_000;

/**
 * The opt-in chime for shaking confirmed near you, while Tremor is open: a tone, a vibration, a
 * note on the page, and a notification where the browser allows one. Once per shaking: whatever
 * is reported within ten minutes of shaking it already chimed for is the same shaking.
 */
export function chime(live: LiveNetwork, place: Place) {
  let on = false;
  let audio: AudioContext | null = null;
  /** When the shaking it chimed for happened. */
  let told: number[] = [];
  const note = h(
    'div',
    { class: 'chime-note', role: 'alert', hidden: true },
    h('p', {}, CHIME_TEXT),
    h('button', { class: 'btn', onclick: () => (note.hidden = true) }, 'Dismiss'),
  );

  /** When each recent shaking near you happened that confirmed reports say you would notice. Provisional detections never count: their phones may still withdraw. */
  const shaking = () => {
    const now = Date.now();
    const you = place.location;
    if (!you) return [];
    return nearYou(live, you, now)
      .filter((x) => x.kind !== 'provisional' && x.level !== null && x.level >= CHIME_LEVEL && now - x.time < RECENT_MS)
      .map((x) => x.time);
  };

  function ring() {
    if (audio) {
      // A bell-like tone: struck, then fading over a second and a half.
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 1.5);
    }
    navigator.vibrate?.([300, 150, 300]);
    if (typeof Notification === 'function' && Notification.permission === 'granted') {
      try {
        new Notification('Tremor', { body: CHIME_TEXT, tag: 'tremor-chime' });
      } catch {
        // shortcut: Chrome on Android shows notifications only from a service worker, which Tremor has none of, so there the tone, vibration and note go alone; add one if people ask for alerts from a background tab there.
      }
    }
    note.hidden = false;
  }

  live.on(() => {
    if (!on) return;
    const fresh = shaking().filter((t) => !told.some((s) => Math.abs(s - t) < NEAR_MS));
    if (!fresh.length) return;
    told.push(...fresh);
    ring();
  });

  return {
    note,
    get on() {
      return on;
    },
    set(next: boolean) {
      on = next;
      if (!on) return;
      // Only what is reported after the tap chimes.
      told = shaking();
      // A page may start sound, and ask to notify, only from a tap like this one.
      audio ??= typeof AudioContext === 'function' ? new AudioContext() : null;
      void audio?.resume();
      if (typeof Notification === 'function' && Notification.permission === 'default') void Notification.requestPermission();
    },
  };
}
