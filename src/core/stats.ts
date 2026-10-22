/** The middle value, or the mean of the middle two when the count is even. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The upper median: the larger of the middle two when the count is even, so always one of the
 * values themselves; null when there are none. Not the same as `median`, on purpose.
 */
export function upperMedian(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
