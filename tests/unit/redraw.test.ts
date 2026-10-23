import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redrawer } from '../../src/ui/redraw';

describe('a screen redrawn at most a few times a second, from an animation frame', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const frames = {
    now: () => Date.now(),
    raf: (f: () => void) => setTimeout(f, 16) as unknown as number,
    caf: (id: number) => clearTimeout(id),
  };

  it('draws a burst of changes once, and no more often than its gap', () => {
    const draw = vi.fn();
    const r = redrawer(draw, 250, frames);
    for (let i = 0; i < 50; i++) r.request();
    vi.advanceTimersByTime(40);
    expect(draw).toHaveBeenCalledTimes(1);
    r.request();
    r.request();
    vi.advanceTimersByTime(100);
    expect(draw).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('draws nothing once cancelled, whether its wait or its frame was pending', () => {
    const draw = vi.fn();
    const r = redrawer(draw, 250, frames);
    r.request();
    vi.advanceTimersByTime(20);
    expect(draw).toHaveBeenCalledTimes(1);
    r.request();
    r.cancel();
    vi.advanceTimersByTime(5000);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const waiting = vi.fn();
    const w = redrawer(waiting, 250, frames);
    w.request();
    vi.advanceTimersByTime(0);
    w.cancel();
    vi.advanceTimersByTime(5000);
    expect(waiting).not.toHaveBeenCalled();
    w.request();
    vi.advanceTimersByTime(5000);
    expect(waiting).not.toHaveBeenCalled();
  });

  it('slows to four times what a draw took, up to two seconds', () => {
    let spent = 0;
    const clock = { ...frames, now: () => Date.now() + spent };
    let took = 300;
    const draw = vi.fn(() => (spent += took));
    const r = redrawer(draw, 250, clock);
    r.request();
    vi.advanceTimersByTime(20);
    expect(draw).toHaveBeenCalledTimes(1);
    r.request();
    vi.advanceTimersByTime(800);
    expect(draw).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(draw).toHaveBeenCalledTimes(2);
    took = 1000;
    spent += 10_000;
    r.request();
    vi.advanceTimersByTime(60);
    expect(draw).toHaveBeenCalledTimes(3);
    r.request();
    vi.advanceTimersByTime(900);
    expect(draw).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(150);
    expect(draw).toHaveBeenCalledTimes(4);
  });
});
