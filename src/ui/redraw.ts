export interface Frames {
  now(): number;
  raf(f: () => void): number;
  caf(id: number): void;
}

const browser: Frames = { now: () => performance.now(), raf: (f) => requestAnimationFrame(f), caf: (id) => cancelAnimationFrame(id) };

/**
 * Redraws a screen on request, at most every `every` ms, and slower (four times what a draw took,
 * up to 2 s) when drawing is dear. The draw runs in an animation frame, never from a timer
 * alone. `cancel` ends it for good: a wait or a frame still pending is dropped, so a screen that
 * has been left cannot draw over the next one.
 */
export function redrawer(draw: () => void, every: number, frames: Frames = browser) {
  let queued = false;
  let ended = false;
  let lastDrawn = 0;
  let rest = every;
  let wait: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  return {
    request() {
      if (queued || ended) return;
      queued = true;
      wait = setTimeout(
        () => {
          frame = frames.raf(() => {
            frame = undefined;
            queued = false;
            lastDrawn = frames.now();
            draw();
            rest = Math.min(2000, Math.max(every, 4 * (frames.now() - lastDrawn)));
          });
        },
        Math.max(0, rest - (frames.now() - lastDrawn)),
      );
    },
    cancel() {
      ended = true;
      queued = false;
      clearTimeout(wait);
      if (frame !== undefined) frames.caf(frame);
      frame = undefined;
    },
  };
}
