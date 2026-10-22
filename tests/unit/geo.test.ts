import { describe, expect, it } from 'vitest';
import { parseLatLon } from '../../src/core/geo';

describe('typed coordinates', () => {
  it('reads a latitude and a longitude, split by a comma or spaces', () => {
    expect(parseLatLon('37.80, -122.27')).toEqual({ lat: 37.8, lon: -122.27 });
    expect(parseLatLon(' 27.7 85.32 ')).toEqual({ lat: 27.7, lon: 85.32 });
    expect(parseLatLon('-33.9249,18.4241')).toEqual({ lat: -33.9249, lon: 18.4241 });
  });

  it('refuses what it would have to guess at, and what is out of range', () => {
    for (const t of ['', '38.7', '52,52, 13,40', '37.77 S, 122.42 W', '1e1, 2', '0x10, 2', '1, 2, 3', '95, 10', '10, 181']) expect(parseLatLon(t), t).toBeNull();
  });
});
