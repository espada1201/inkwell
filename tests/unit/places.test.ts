import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { epicentreTown, findTowns, nearestTown, parseTowns, townLabel } from '../../src/core/places';

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
    expect(labels('Lodz')).toEqual(['Łódź, PL']);
    expect(labels('Xian')).toEqual(['Xi’an, CN']);
    expect(labels("xi'an")).toEqual(['Xi’an, CN']);
    expect(labels('zurich')).toEqual(['Zürich, CH']);
  });

  it('takes a name that holds a comma itself, and the countries people call by other names', () => {
    expect(labels('Washington, D.C.')).toEqual(['Washington, D.C., DC, US']);
    expect(labels('London, UK')).toEqual(['London, GB']);
    expect(labels('London, Canada')).toEqual(expect.arrayContaining(['London, GB', 'London, CA']));
    expect(labels('London, CA')).toEqual(['London, CA']);
  });

  it('returns every match, however many, for the form to cut down', () => {
    expect(findTowns(towns, 'Springfield').length).toBeGreaterThan(6);
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

  it('names the town nearest a place, and none out at sea', () => {
    expect(townLabel(nearestTown(towns, { lat: 37.97, lon: -122.53 })!)).toBe('San Rafael, CA, US');
    expect(nearestTown(towns, { lat: 30, lon: -140 })).toBeNull();
  });
});

describe('the town a quake is named for', () => {
  it('is the biggest town within 10 km of the epicentre, not the closest hamlet: Napa, not American Canyon', () => {
    expect(townLabel(epicentreTown(towns, { lat: 38.215, lon: -122.312 })!)).toBe('Napa, CA, US');
    expect(townLabel(epicentreTown(towns, { lat: -43.583, lon: 172.68 })!)).toBe('Christchurch, NZ');
  });

  it('is the nearest town within 25 km when none is within 10 km, and none out at sea', () => {
    expect(townLabel(epicentreTown(towns, { lat: 35.77, lon: -117.599 })!)).toBe('Ridgecrest, CA, US');
    expect(epicentreTown(towns, { lat: 0, lon: -140 })).toBeNull();
  });
});
