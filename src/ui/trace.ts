import type { SensorNode } from '../app/sensor';
import { css, fit } from './canvas';

/** Live drum-recorder trace of this phone's shaking, newest on the right. */
export function drawTrace(canvas: HTMLCanvasElement, s: SensorNode) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const ink = css('--night-ink');
  const rule = css('--night-rule');
  const red = css('--red');
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * i) / 6);
    ctx.lineTo(w, (h * i) / 6);
    ctx.stroke();
  }
  const n = s.trace.length;
  if (!n) return;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, s.trace[i]);
  const scale = Math.max(0.08, peak * 1.15);
  const mid = h / 2;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const k = (s.head + i) % n;
    const v = (s.trace[k] / scale) * (i % 2 ? 1 : -1);
    const px = (i / (n - 1)) * w;
    const py = mid - v * mid * 0.92;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  const thr = s.detector && !s.detector.warmingUp ? s.detector.triggerLevel : 0;
  if (thr > 0 && thr < scale) {
    ctx.strokeStyle = red;
    ctx.setLineDash([5, 4]);
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, mid - sign * (thr / scale) * mid * 0.92);
      ctx.lineTo(w, mid - sign * (thr / scale) * mid * 0.92);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.fillStyle = css('--night-muted');
  ctx.font = `11px ${css('--mono')}`;
  ctx.fillText(`±${scale.toFixed(2)} m/s²`, 8, 16);
  ctx.fillText(`${(n / Math.max(s.fs, 1)).toFixed(0)} s`, w - 32, h - 8);
}
