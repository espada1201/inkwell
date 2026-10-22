import type { Summary } from '../core/planner';
import { h } from './dom';
import { many, pct, secs } from './format';

const NS = 'http://www.w3.org/2000/svg';
const W = 360;
const H = 196;
const M = { l: 34, r: 64, t: 14, b: 26 };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const fmtN = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));

const SERIES = [
  { key: 'detected', label: 'quakes detected', color: 'var(--muted)', get: (s: Summary) => s.detected },
  { key: 'warned', label: 'shaken area warned in time', color: 'var(--red)', get: (s: Summary) => s.warned },
] as const;

/**
 * "How many phones are enough?": detection rate and the share of the shaken area warned
 * before the S wave, against the number of phones listening (log scale). Points fill in
 * as the planner finishes them; `current` marks the user's own choice, which the axis
 * stretches to include.
 */
export function sweepChart(counts: number[], points: Summary[], current: number) {
  const lo = Math.min(counts[0], current);
  const hi = Math.max(counts[counts.length - 1], current);
  const x = (n: number) => M.l + ((Math.log(n) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - M.l - M.r);
  const y = (v: number) => M.t + (1 - v) * (H - M.t - M.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'group', 'aria-label': 'Quakes detected and shaken area warned in time, by number of phones' });
  // Drawn for the eye; screen readers get one band per phone count, below, and the Numbers table.
  const art = el('g', { 'aria-hidden': 'true' });
  svg.append(art);
  for (const v of [0, 0.5, 1]) {
    art.append(el('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: 'grid' }));
    art.append(el('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, `${v * 100}%`));
  }
  // The axis ends are labelled too, unless the label would land on a neighbour's.
  const ticks = [...new Set([lo, ...counts, hi])].filter((n) => counts.includes(n) || counts.every((k) => Math.abs(x(k) - x(n)) >= 20));
  for (const n of ticks) art.append(el('text', { x: x(n), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, fmtN(n)));
  art.append(el('line', { x1: x(current), x2: x(current), y1: M.t - 6, y2: H - M.b, class: 'you' }));

  const sorted = [...points].sort((a, b) => a.phones - b.phones);
  const ends: { y: number; label: string }[] = [];
  for (const s of SERIES) {
    const pts = sorted.flatMap((p) => {
      const v = s.get(p);
      return v === null ? [] : [{ n: p.phones, v }];
    });
    if (!pts.length) continue;
    art.append(el('polyline', { points: pts.map((p) => `${x(p.n)},${y(p.v)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const p of pts) art.append(el('circle', { cx: x(p.n), cy: y(p.v), r: 4, fill: s.color, class: 'dot' }));
    const last = pts[pts.length - 1];
    if (last.n === hi) ends.push({ y: y(last.v), label: s.key });
  }
  // Direct labels at the line ends, unless they would collide (the legend still names both).
  if (ends.length === 2 ? Math.abs(ends[0].y - ends[1].y) > 13 : ends.length === 1) {
    for (const e of ends) art.append(el('text', { x: W - M.r + 8, y: e.y + 4, class: 'end' }, e.label));
  }

  const tip = h('div', { class: 'chart-tip', hidden: true, role: 'status' });
  const show = (s: Summary, px: number) => {
    tip.replaceChildren(
      h('b', {}, many(s.phones, 'phone')),
      h('span', {}, h('i', { class: 'key' }), `${pct(s.warned)} warned in time`, s.medianWarningS !== null ? ` · median ${secs(s.medianWarningS)}` : ''),
      h('span', {}, h('i', { class: 'key muted' }), `${pct(s.detected)} detected`, s.medianAlertS !== null ? ` · first alert ${secs(s.medianAlertS)}` : ''),
    );
    tip.hidden = false;
    tip.style.left = `${(px / W) * 100}%`;
  };
  // One hit band per phone count, wider than the marks, reachable by keyboard too.
  sorted.forEach((s, i) => {
    const left = i ? (x(sorted[i - 1].phones) + x(s.phones)) / 2 : M.l;
    const right = i < sorted.length - 1 ? (x(s.phones) + x(sorted[i + 1].phones)) / 2 : W - M.r;
    const band = el('rect', { x: left, y: M.t, width: Math.max(1, right - left), height: H - M.t - M.b, class: 'band', tabindex: 0, role: 'img', 'aria-label': `${many(s.phones, 'phone')}: ${pct(s.detected)} detected, ${pct(s.warned)} warned in time` });
    band.addEventListener('pointerenter', () => show(s, x(s.phones)));
    band.addEventListener('focus', () => show(s, x(s.phones)));
    band.addEventListener('pointerleave', () => (tip.hidden = true));
    band.addEventListener('blur', () => (tip.hidden = true));
    svg.append(band);
  });

  const legend = h(
    'div',
    { class: 'legend-inline' },
    ...[...SERIES].reverse().map((s) => h('span', {}, h('i', { style: `background:${s.color}` }), s.label)),
    h('span', {}, h('i', { class: 'you-key' }), 'your choice'),
  );
  const table = h(
    'details',
    { class: 'chart-table' },
    h('summary', {}, 'Numbers'),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...['Phones', 'Detected', 'First alert', 'Warned in time', 'Median warning'].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        ...sorted.map((s) =>
          h('tr', {}, h('td', {}, s.phones), h('td', {}, pct(s.detected)), h('td', {}, secs(s.medianAlertS)), h('td', {}, pct(s.warned)), h('td', {}, secs(s.medianWarningS))),
        ),
      ),
    ),
  );
  return h('div', { class: 'chart-wrap', 'data-testid': 'sweep' }, legend, h('div', { class: 'chart-box' }, svg, tip), table);
}
