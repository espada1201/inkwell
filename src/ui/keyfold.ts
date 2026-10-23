export interface Foldable {
  open: boolean;
  matches(selector: string): boolean;
}

/**
 * Folds an open map key away once the map is used, or after 15 s, unless the reader has touched
 * it. While the pointer or focus is on the key it asks again every 5 s. One timer, whatever the
 * number of wheel turns and taps: a new ask replaces the one waiting.
 */
export function keyFolder(legend: Foldable, firstMs = 15_000, againMs = 5000) {
  let touched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(fold, ms);
  };
  function fold() {
    clearTimeout(timer);
    timer = undefined;
    if (touched || !legend.open) return;
    if (legend.matches(':hover, :focus-within')) return ask(againMs);
    legend.open = false;
  }
  ask(firstMs);
  return {
    use: fold,
    touched: () => {
      touched = true;
      clearTimeout(timer);
      timer = undefined;
    },
    stop: () => clearTimeout(timer),
  };
}
