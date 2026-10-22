import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findTowns, parseTowns, townLabel } from '../../src/core/places';

const towns = parseTowns(readFileSync(new URL('../../src/data/places.tsv', import.meta.url), 'utf8'));
const labels = (typed: string) => findTowns(towns, typed).map(townLabel);

describe('towns by name', () => {
  it('reads the bundled list, biggest first, without its header', () => {
    expect(towns.length).toBeGreaterThan(20_000);
    expect(towns[0].name).toBe('Shanghai');
    expect(towns.find((t) => t.name.startsWith('#'))).toBeUndefined();
  });

  it('finds a town by its name, whatever the case and accents', () => {
    expect(findTowns(towns, 'vallejo')).toEqual([{ name: 'Vallejo', country: 'US', state: 'CA', lat: 38.1, lon: -122.26 }]);
    expect(labels('Sao Paulo')[0]).toBe('São Paulo, BR');
  });

  it('offers every town of that name, biggest first, and narrows by state or country', () => {
    expect(labels('San Rafael')).toEqual(expect.arrayContaining(['San Rafael, CA, US', 'San Rafael, AR']));
    expect(labels('San Rafael, CA')).toEqual(['San Rafael, CA, US']);
    expect(labels('Springfield, Illinois')).toEqual(['Springfield, IL, US']);
    expect(labels('springfield, usa').every((l) => l.endsWith(', US'))).toBe(true);
    expect(labels('Valencia, ES')).toEqual(['Valencia, ES']);
  });

  it('falls back to towns whose name starts with what was typed, and finds nothing for nonsense', () => {
    expect(labels('American Can')).toContain('American Canyon, CA, US');
    expect(labels('Qqqqzz')).toEqual([]);
    expect(labels(' , ')).toEqual([]);
  });
});
