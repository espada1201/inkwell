import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyFolder } from '../../src/ui/keyfold';

describe('the map key that folds away once the map is used', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const legend = (over = false) => {
    const l = { open: true, over, matches: () => l.over };
    return l;
  };
  let legend_ = legend();

  it('folds at once on use, and after 15 s of none', () => {
    legend_ = legend();
    const fold = keyFolder(legend_);
    fold.use();
    expect(legend_.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    legend_ = legend();
    keyFolder(legend_);
    vi.advanceTimersByTime(14_999);
    expect(legend_.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(legend_.open).toBe(false);
  });

  it('keeps one timer however often the map is used while the pointer is over the key', () => {
    legend_ = legend(true);
    const fold = keyFolder(legend_);
    for (let i = 0; i < 200; i++) fold.use();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(legend_.open).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    legend_.over = false;
    vi.advanceTimersByTime(5000);
    expect(legend_.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the key open once the reader has used it', () => {
    legend_ = legend();
    const fold = keyFolder(legend_);
    fold.touched();
    fold.use();
    vi.advanceTimersByTime(60_000);
    expect(legend_.open).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
