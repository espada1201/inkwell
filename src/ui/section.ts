import type { Replay } from '../app/replay';
import { DEFAULT_DEPTH_KM, VP_KMS, VS_KMS, hypocentralKm } from '../core/physics';
import { ORIGIN_OFFSET_S } from '../core/scenarios';
import { FS } from '../core/simnet';
import { css, fit } from './canvas';

/**
 * Record section: every phone's trace stacked by distance from the epicentre, time on x.
 * Real seismologists read quakes this way; the P and S arrivals line up along straight
 * moveout curves, drawn dashed from the reference hypocentre.
 */
export function drawSection(canvas: HTMLCanvasElement, r: Replay) {
  const { ctx, w, h } = fit(canvas);
  const ink = css('--ink');
  const faint = css('--rule');
  const red = css('--red');
  const amber = css('--amber');
  const muted = css('--muted');
  ctx.clearRect(0, 0, w, h);
  const padL = 34;
  const padB = 20;
  const padT = 8;
  const pw = w - padL - 8;
  const ph = h - padB - padT;
  const sim = r.sim;
  if (!sim) return;
  const truth = sim.scenario.truth;
  const depth = truth?.depthKm ?? DEFAULT_DEPTH_KM;
  const nodes = [...r.nodes].sort((a, b) => (a.distKm ?? 0) - (b.distKm ?? 0));
  const maxD = truth ? Math.max(20, ...nodes.map((n) => n.distKm ?? 0)) * 1.05 : nodes.length;
  // Time on the replay clock: from just before the origin, or across a whole replay with no quake.
  const [tMin, tMax] = truth ? [-5, sim.durationS - ORIGIN_OFFSET_S - 5] : [0, sim.durationS];
  /** Scenario seconds at which the clock reads zero. */
  const zero = -r.clockAt(0);
  const x = (t: number) => padL + ((t - tMin) / (tMax - tMin)) * pw;
  const y = (d: number) => padT + (d / maxD) * ph;

  ctx.font = `10px ${css('--mono')}`;
  ctx.fillStyle = muted;
  ctx.strokeStyle = faint;
  ctx.lineWidth = 1;
  for (let t = Math.ceil(tMin / 10) * 10; t <= tMax; t += 10) {
    ctx.beginPath();
    ctx.moveTo(x(t), padT);
    ctx.lineTo(x(t), padT + ph);
    ctx.stroke();
    ctx.fillText(`${t}s`, x(t) - 6, h - 6);
  }
  if (truth) {
    const step = maxD > 120 ? 50 : maxD > 50 ? 20 : 10;
    for (let d = 0; d <= maxD; d += step) {
      ctx.fillText(`${d}`, 2, y(d) + 3);
    }
    ctx.save();
    ctx.translate(10, padT + ph / 2);
    ctx.fillText('km', -6, 30);
    ctx.restore();
    // Moveout curves
    for (const [v, color, label] of [[VP_KMS, ink, 'P'], [VS_KMS, red, 'S']] as const) {
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let d = 0; d <= maxD; d += maxD / 60) {
        const t = hypocentralKm(d, depth) / v;
        if (d === 0) ctx.moveTo(x(t), y(d));
        else ctx.lineTo(x(t), y(d));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      const tEnd = hypocentralKm(maxD * 0.92, depth) / v;
      if (tEnd < tMax) ctx.fillText(label, x(tEnd) + 4, y(maxD * 0.92));
    }
  }

  const now = r.clockAt(r.vt);
  const rowH = Math.max(6, Math.min(26, (ph / Math.max(nodes.length, 1)) * 2.2));
  const x0 = Math.ceil(x(tMin));
  const x1 = Math.floor(x(Math.min(now, tMax)));
  const pxPerS = pw / (tMax - tMin);
  nodes.forEach((n, i) => {
    const base = truth ? y(n.distKm ?? 0) : y(i + 0.5);
    // Background level from the quiet first seconds, so noise draws as a hairline.
    let floor = 0;
    for (let k = FS; k < FS * 6; k++) floor += n.trace[k] / (FS * 5);
    ctx.strokeStyle = n.trigger ? ink : muted;
    ctx.globalAlpha = n.trigger ? 0.85 : 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    // One vertical stroke per pixel column: the peak shaking within it (a drum recorder's ink).
    for (let px = x0; px <= x1; px++) {
      const tA = tMin + (px - padL) / pxPerS + zero;
      const kA = Math.max(0, Math.floor(tA * FS));
      const kB = Math.min(n.trace.length, Math.ceil((tA + 1 / pxPerS) * FS));
      let m = 0;
      for (let k = kA; k < kB; k++) if (n.trace[k] > m) m = n.trace[k];
      const amp = Math.min(1, Math.sqrt(Math.max(0, m - floor * 1.5) / 1.2));
      const half = Math.max(0.5, amp * rowH * 0.5);
      ctx.moveTo(px + 0.5, base - half);
      ctx.lineTo(px + 0.5, base + half);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const mark = (tScen: number, color: string) => {
      const t = r.clockAt(tScen);
      if (t > now || t < tMin || t > tMax) return;
      ctx.fillStyle = color;
      ctx.fillRect(x(t) - 1, base - rowH * 0.45, 2, rowH * 0.9);
    };
    // A confirmed onset, coloured by the wave the phone said it felt: it should sit on that wave's curve.
    if (n.trigger && n.trigger.at <= r.vt) mark(n.trigger.t, n.trigger.phase === 'S' ? red : ink);
    for (const rj of n.rejects) if (rj.at <= r.vt) mark(rj.t, amber);
  });

  // Playhead
  if (now >= tMin && now <= tMax) {
    ctx.strokeStyle = red;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(now), padT);
    ctx.lineTo(x(now), padT + ph);
    ctx.stroke();
  }
}
