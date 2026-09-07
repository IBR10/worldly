// culture.js — pure helpers for the per-country culture pages.
//
// No DOM, no fetch, so it runs under plain `node --test` like quiz.js/maps.js.
//
// The culture content is split into one file per region rather than one big one:
// ~200 countries at full depth is ~450 KB of JSON, and a reader looking at Japan
// should not pay for Bolivia. Six files keep the largest single fetch to about
// 110 KB, and let a region be authored and reviewed as one unit.

/** countries.json `region` value -> the LAZY_FILES key holding its culture rows. */
export const CULTURE_DATASETS = {
  'Africa': 'cultureAfrica',
  'Asia': 'cultureAsia',
  'Europe': 'cultureEurope',
  'North America': 'cultureNorthAmerica',
  'South America': 'cultureSouthAmerica',
  'Oceania': 'cultureOceania',
};

/** Every culture dataset key, for the loader registry and the integrity test. */
export const CULTURE_KEYS = Object.values(CULTURE_DATASETS);

/**
 * Which dataset a country's deep dive lives in, or null for an unknown region.
 * Null is a "show the page without the deep dive" signal, never an error: the
 * page must still render for a country whose region has not been authored yet.
 */
export function datasetKeyForRegion(region) {
  return CULTURE_DATASETS[region] || null;
}

/** The culture row for a country, matched on iso2 (case-insensitively). */
export function cultureFor(rows, iso2) {
  if (!iso2 || !Array.isArray(rows)) return null;
  const want = String(iso2).toLowerCase();
  return rows.find((r) => r.iso2 && String(r.iso2).toLowerCase() === want) || null;
}

/**
 * How complete a country's deep dive is, so the page can be honest about a
 * partially authored entry instead of rendering empty sections.
 */
export function cultureSections(entry) {
  return {
    people: Array.isArray(entry?.people) ? entry.people : [],
    events: Array.isArray(entry?.events) ? entry.events : [],
    culture: Array.isArray(entry?.culture) ? entry.culture : [],
    talkAbout: Array.isArray(entry?.talkAbout) ? entry.talkAbout : [],
    avoid: typeof entry?.avoid === 'string' && entry.avoid ? entry.avoid : '',
    note: typeof entry?.note === 'string' && entry.note ? entry.note : '',
  };
}

/** Initials for the text-only stand-in where a portrait would go. */
export function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
