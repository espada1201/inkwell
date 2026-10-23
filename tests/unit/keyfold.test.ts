import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyFolder } from '../../src/ui/keyfold';

describe('the map key that folds away once the map is used', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const legend = (over = false) => {
    const l = { open: true, over, matches: () => l.over };
    return l;
  };
  const memory = (start: Record<string, string> = {}) => {
    const data = { ...start };
    return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
  };

  it('never folds on a timer, however long it is left, and starts no timer', () => {
    const l = legend();
    keyFolder(l, memory());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(l.open).toBe(true);
  });

  it('folds on the first use of the map', () => {
    const l = legend();
    const fold = keyFolder(l, memory());
    fold.use();
    expect(l.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('folds only that once: a key the reader opened again stays open through the next drag', () => {
    const l = legend();
    const fold = keyFolder(l, memory());
    fold.use();
    l.open = true;
    fold.use();
    expect(l.open).toBe(true);
  });

  it('does not fold under the pointer or focus, and the use is not spent', () => {
    const l = legend(true);
    const fold = keyFolder(l, memory());
    for (let i = 0; i < 200; i++) fold.use();
    expect(l.open).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    l.over = false;
    fold.use();
    expect(l.open).toBe(false);
  });

  it('stays as the reader left it: a choice to keep it open stops the fold, and is remembered for the session', () => {
    const store = memory();
    const l = legend();
    const fold = keyFolder(l, store);
    fold.chose(true);
    fold.use();
    expect(l.open).toBe(true);
    expect(store.data['tremor.key']).toBe('open');

    const again = legend();
    again.open = false;
    keyFolder(again, store).use();
    expect(again.open).toBe(true);
  });

  it('remembers a key the reader closed, and opens it again on a reload', () => {
    const store = memory();
    const fold = keyFolder(legend(), store);
    fold.chose(false);
    expect(store.data['tremor.key']).toBe('closed');
    const l = legend();
    keyFolder(l, store);
    expect(l.open).toBe(false);
  });

  it('works where the browser keeps nothing', () => {
    const l = legend();
    const fold = keyFolder(l, null);
    fold.chose(false);
    fold.use();
    expect(l.open).toBe(true);
  });
});
