// progressmap.js — how much of the world you actually know, derived from data
// the profile already stores.
//
// The home hero and the Progress dashboard both want the same picture: the
// world map with the countries you know coloured in. Nothing new is tracked to
// produce it. Every quiz and map question is filed in the profile's Leitner
// boxes under an id of the form `${mode}:${name}` (see quiz.js#buildPool and
// maps.js#buildPool), so the country a box belongs to is already in the key —
// it only has to be read back out.
//
// That is the whole trick, and it is why this is a derivation rather than a
// feature: answering "capital of Peru" correctly today already made Peru known,
// retroactively, for every profile that has ever existed.
//
// Pure and DOM-free, like quiz.js / maps.js / languages.js, so it unit-tests
// under plain `node --test`.

/** Leitner box -> how well the country is known. The boxes run 0–5; a box only
 *  climbs on a correct answer, so box >= 1 means "answered right at least
 *  once". Three visible steps, because a legend with six is a legend nobody
 *  reads. */
const LEVEL_FOR_BOX = [0, 1, 1, 2, 2, 3];

/** Every class this module can emit, so a repaint can clear a previous one. */
export const MASTERY_CLASSES = ['known-1', 'known-2', 'known-3'];

/**
 * Split an SRS item id into its mode and its subject.
 *
 * Ids are `${mode}:${name}`, and a name may itself contain a colon (none do
 * today, but "Cocos: Keeling" is the kind of thing datasets grow), so only the
 * first separator is significant.
 *
 * @param {string} id
 * @returns {{mode: string, subject: string} | null}
 */
export function splitItemId(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return null;
  return { mode: id.slice(0, at), subject: id.slice(at + 1) };
}

/**
 * How well each country is known, from the profile's SRS boxes.
 *
 * A country's level is the best it has reached in any mode — knowing Peru's
 * capital and knowing Peru's flag are both knowing Peru. Items whose subject is
 * not a country (US states, Mexican states, religions, Pokémon) simply do not
 * match and are ignored.
 *
 * @param {Record<string, {box?: number}>} srs  profile.srs
 * @param {Array<{name: string, iso2: string}>} countries
 * @returns {Record<string, 0|1|2|3>} ISO-3166 alpha-2 (upper case) -> level
 */
export function countryMastery(srs, countries) {
  const byName = new Map();
  for (const c of countries || []) {
    if (c && c.name && c.iso2) byName.set(c.name, c.iso2.toUpperCase());
  }

  const out = {};
  for (const iso2 of byName.values()) out[iso2] = 0;

  for (const [id, entry] of Object.entries(srs || {})) {
    const parts = splitItemId(id);
    if (!parts) continue;
    const iso2 = byName.get(parts.subject);
    if (!iso2) continue;
    const box = Math.max(0, Math.min(5, Math.round(Number(entry?.box) || 0)));
    const level = LEVEL_FOR_BOX[box];
    if (level > out[iso2]) out[iso2] = level;
  }
  return out;
}

/**
 * The paint instruction for the map: lowercase SVG region id -> CSS class.
 *
 * Lowercased because world.svg uses lowercase ISO-3166 alpha-2 while the
 * datasets use upper case — the same join languages.js#regionClassesFor and
 * maps.js#regionIdFor perform. Countries at level 0 are left out entirely so
 * they keep the plain land fill.
 *
 * @param {Record<string, number>} mastery  output of countryMastery()
 * @returns {Record<string, string>}
 */
export function masteryClasses(mastery) {
  const out = {};
  for (const [iso2, level] of Object.entries(mastery || {})) {
    if (level >= 1 && level <= 3) out[iso2.toLowerCase()] = `known-${level}`;
  }
  return out;
}

/**
 * Headline discovery numbers, overall and per continent.
 *
 * "Known" is level >= 1: one correct answer about a country counts as having
 * found it. `pct` is rounded, but never rounded up to 100 while anything is
 * still missing — a map with three grey countries left must not claim to be
 * finished.
 *
 * @param {Record<string, number>} mastery
 * @param {Array<{iso2: string, region: string}>} countries
 * @returns {{known: number, total: number, pct: number, mastered: number,
 *            byRegion: Array<{region: string, known: number, total: number, pct: number}>}}
 */
export function discoveryStats(mastery, countries) {
  const m = mastery || {};
  const regions = new Map();
  let known = 0, total = 0, mastered = 0;

  for (const c of countries || []) {
    if (!c || !c.iso2) continue;
    const level = m[c.iso2.toUpperCase()] || 0;
    const region = c.region || 'Other';
    if (!regions.has(region)) regions.set(region, { region, known: 0, total: 0, pct: 0 });
    const r = regions.get(region);
    r.total += 1;
    total += 1;
    if (level >= 1) { r.known += 1; known += 1; }
    if (level >= 3) mastered += 1;
  }

  for (const r of regions.values()) r.pct = pct(r.known, r.total);

  return {
    known,
    total,
    mastered,
    pct: pct(known, total),
    byRegion: [...regions.values()].sort((a, b) => b.total - a.total || a.region.localeCompare(b.region)),
  };
}

/** Percentage that never reads 100 until it really is, nor 0 once something is
 *  there — the two lies a plain Math.round tells on a 198-item denominator. */
function pct(part, whole) {
  if (!whole) return 0;
  if (part === 0) return 0;
  if (part === whole) return 100;
  return Math.min(99, Math.max(1, Math.round((part / whole) * 100)));
}

/** A continent's tint class, matching the continent key in css/components.css.
 *  Unknown regions get no class and fall back to brass. */
export function continentClass(region) {
  return `con-${String(region || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;
}
