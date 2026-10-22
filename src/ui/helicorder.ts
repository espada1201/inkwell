const STEP_MS = 120;
const PX = 2;

/**
 * Header helicorder: a pen drawing activity as it happens, scrolling right to left, one stroke
 * per tick as tall as `read()` (0..1) says. Quiet stretches leave the paper blank.
 */
export function startHelicorder(canvas: HTMLCanvasElement, read: () => number) {
  const trace: number[] = [];
  return setInterval(() => {
    const ctx = canvas.getContext('2d')!;
    const w = (canvas.width = canvas.clientWidth);
    const hh = (canvas.height = 16);
    trace.push(read());
    const n = Math.ceil(w / PX);
    if (trace.length > n) trace.splice(0, trace.length - n);
    ctx.clearRect(0, 0, w, hh);
    ctx.strokeStyle = '#c8261c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Shaking draws upward strokes onto the header rule.
    trace.forEach((v, i) => {
      if (v < 0.02) return;
      const x = w - (trace.length - i) * PX + 0.5;
      ctx.moveTo(x, hh);
      ctx.lineTo(x, hh - 1 - v * 13);
    });
    ctx.stroke();
  }, STEP_MS);
}
