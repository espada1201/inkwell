type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

/** Tiny DOM builder. Text children become text nodes, so untrusted strings are never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

/**
 * Rebuild a panel without losing keyboard focus: the element focused before is found again by
 * its data-key, or else by its tag and text.
 */
export function keepFocus(root: HTMLElement, rebuild: () => void) {
  const key = (el: Element) => (el instanceof HTMLElement && el.dataset.key) || `${el.tagName}:${el.textContent}`;
  const was = document.activeElement;
  const k = was && was !== document.body && root.contains(was) ? key(was) : null;
  rebuild();
  if (k === null || root.contains(document.activeElement)) return;
  for (const el of root.querySelectorAll<HTMLElement>(was!.tagName)) if (key(el) === k) return el.focus({ preventScroll: true });
}
