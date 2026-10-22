import type { LatLon } from './geo';

/** A town people can name instead of typing coordinates. */
export interface Town extends LatLon {
  name: string;
  country: string;
  /** The US state's two-letter code; empty elsewhere. */
  state: string;
}

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};
const US = new Set(['us', 'usa', 'united states', 'america']);

/** Lower case, without accents or punctuation, so "São Paulo" and "sao paulo" match. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The bundled list: one town per line, biggest first, as `name, country, state, lat, lon` separated by tabs. */
export function parseTowns(tsv: string): Town[] {
  return tsv
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [name, country, state, lat, lon] = l.split('\t');
      return { name, country, state, lat: Number(lat), lon: Number(lon) };
    });
}

export const townLabel = (t: Town) => [t.name, t.state, t.country].filter(Boolean).join(', ');

/**
 * Towns called what was typed, biggest first. Words after a comma narrow it down by US state (code or name) or
 * country code: "Vallejo", "San Rafael, CA", "Springfield, Illinois", "Valencia, ES". With no town of exactly that
 * name, towns whose name starts with it.
 */
export function findTowns(towns: Town[], typed: string, max = 6): Town[] {
  const [name, ...rest] = typed.split(',').map(fold);
  if (!name) return [];
  const where = rest.filter(Boolean);
  const fits = (t: Town) =>
    where.every((w) => {
      const code = w.toUpperCase();
      return t.state === code || t.state === STATES[w] || t.country === code || (US.has(w) && t.country === 'US');
    });
  const named = towns.filter((t) => fold(t.name) === name && fits(t));
  return (named.length ? named : towns.filter((t) => fold(t.name).startsWith(name) && fits(t))).slice(0, max);
}
