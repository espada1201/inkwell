import { distanceKm, type LatLon } from './geo';

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

/** Country codes people type that the list spells otherwise. */
const COUNTRY_ALIASES: Record<string, string> = { uk: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', britain: 'GB' };
/** Letters that do not come apart into a plain letter and an accent. */
const PLAIN: Record<string, string> = { ł: 'l', ø: 'o', ı: 'i', đ: 'd', ð: 'd', þ: 'th', ß: 'ss', æ: 'ae', œ: 'oe' };

/**
 * Lower case and plain Latin letters, without accents, apostrophes or spaces, so "São Paulo" and "sao paulo",
 * "Łódź" and "Lodz", "Xi’an" and "Xian" match.
 */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[łøıđðþßæœ]/g, (c) => PLAIN[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');

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
 * Every town called what was typed, biggest first. Words after a comma narrow it down by US state (code or name) or
 * country code: "Vallejo", "San Rafael, CA", "Springfield, Illinois", "Valencia, ES", "London, UK". With no town of
 * exactly that name, towns whose name starts with it; with words after a comma it cannot place, every town of the name.
 */
export function findTowns(towns: Town[], typed: string): Town[] {
  // A name can hold a comma itself ("Washington, D.C."), so the whole of it is tried first.
  const whole = fold(typed);
  if (!whole) return [];
  const exact = towns.filter((t) => fold(t.name) === whole);
  if (exact.length) return exact;
  const [name, ...rest] = typed.split(',');
  const key = fold(name);
  if (!key) return [];
  const where = rest.map((w) => w.trim().toLowerCase()).filter(Boolean);
  const fits = (t: Town) =>
    where.every((w) => {
      const code = (COUNTRY_ALIASES[w] ?? w).toUpperCase();
      return t.state === code || t.state === STATES[w] || t.country === code || (US.has(w) && t.country === 'US');
    });
  const byName = towns.filter((t) => fold(t.name) === key);
  const named = byName.filter(fits);
  if (named.length) return named;
  const starting = towns.filter((t) => fold(t.name).startsWith(key) && fits(t));
  // A country spelled out ("London, Canada") is not one it knows: offer every town of that name to pick from.
  return starting.length ? starting : byName;
}

/** The town nearest p, if one is within `km`: a place found by the browser reads "near San Rafael", not as bare numbers. */
export function nearestTown(towns: Town[], p: LatLon, km = 25): Town | null {
  let best: Town | null = null;
  let d = km;
  for (const t of towns) {
    const k = distanceKm(t, p);
    if (k < d) [best, d] = [t, k];
  }
  return best;
}

/**
 * The town a quake is named for: the biggest within `bigKm` of the epicentre (Napa, not the closer American Canyon), else the
 * nearest within `maxKm`. The list is biggest first.
 */
export function epicentreTown(towns: Town[], epicentre: LatLon, bigKm = 10, maxKm = 25): Town | null {
  return towns.find((t) => distanceKm(t, epicentre) <= bigKm) ?? nearestTown(towns, epicentre, maxKm);
}
