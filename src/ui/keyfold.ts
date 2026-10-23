export interface Foldable {
  open: boolean;
  matches(selector: string): boolean;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'tremor.key';

/** This tab's sessionStorage, or null where the browser blocks it; a refused write is dropped. */
export function sessionStore(): Store | null {
  let store: Storage | undefined;
  try {
    store = globalThis.sessionStorage;
  } catch {
    return null;
  }
  if (!store) return null;
  return {
    getItem: (k) => store.getItem(k),
    setItem: (k, v) => {
      try {
        store.setItem(k, v);
      } catch {}
    },
  };
}

/**
 * Folds an open map key away the first time the map is pressed, dragged or wheeled, and never on a timer: a key that
 * vanishes while it is being read is lost to the people who read slowest. Once the reader opens or closes it
 * (`chose`) it stays as chosen, and the choice is kept for the tab's session. While the pointer or focus is on
 * the key a map press does not fold it.
 */
export function keyFolder(legend: Foldable, store: Store | null) {
  let settled = false;
  try {
    const kept = store?.getItem(KEY);
    if (kept === 'open' || kept === 'closed') {
      legend.open = kept === 'open';
      settled = true;
    }
  } catch {
    /* no memory of it */
  }
  return {
    use() {
      if (settled || !legend.open || legend.matches(':hover, :focus-within')) return;
      settled = true;
      legend.open = false;
    },
    chose(open: boolean) {
      settled = true;
      store?.setItem(KEY, open ? 'open' : 'closed');
    },
  };
}
