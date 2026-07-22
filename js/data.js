// data.js — loads the raw datasets and exposes them to the rest of the app.
// Everything is static JSON shipped with the app, so a single fetch at startup
// is enough. We keep the loaded data on a module-level singleton.

import { parseSvgRegions } from './maps.js';

const DATA = {
  countries: [],
  usStates: [],
  mxStates: [],
  caStates: [],
  historicFlags: [],
  similarFlags: [],
  religions: [],
  phrases: [],
  music: [],
  crises: [],
  achievements: [],
  loaded: false,
};

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

/**
 * Load the datasets every screen depends on. Safe to call multiple times.
 *
 * The three Explore-only datasets (phrases, music, crises — about 30 KB
 * together) are NOT loaded here: they were previously fetched and parsed on
 * the critical path by every visitor, including the majority who never open
 * those screens. They now load on demand via loadDataset(), reusing the same
 * in-flight-promise caching as the map SVGs below.
 */
export async function loadData() {
  if (DATA.loaded) return DATA;
  const [countries, usStates, mxStates, caStates, historicFlags, similarFlags, religions, achievements] = await Promise.all([
    loadJSON('data/countries.json'),
    loadJSON('data/us_states.json'),
    loadJSON('data/mexico_states.json'),
    loadJSON('data/canada_provinces.json'),
    loadJSON('data/historic_flags.json'),
    loadJSON('data/similar_flags.json'),
    loadJSON('data/religions.json'),
    loadJSON('data/achievements.json'),
  ]);
  DATA.countries = countries;
  DATA.usStates = usStates;
  DATA.mxStates = mxStates;
  DATA.caStates = caStates;
  DATA.historicFlags = historicFlags;
  DATA.similarFlags = similarFlags;
  DATA.religions = religions;
  DATA.achievements = achievements;
  DATA.loaded = true;
  return DATA;
}

// On-demand datasets: name -> the promise that resolves once it has landed.
const LAZY = {};
const LAZY_FILES = {
  phrases: 'data/phrases.json',
  music: 'data/music.json',
  crises: 'data/crises.json',
};

/**
 * Fetch one Explore dataset, populating DATA[name]. Repeat calls share the
 * in-flight promise, and a failure never poisons the cache for retries.
 * @param {'phrases'|'music'|'crises'} name
 */
export function loadDataset(name) {
  if (LAZY[name]) return LAZY[name];
  const path = LAZY_FILES[name];
  if (!path) return Promise.reject(new Error(`Unknown dataset: ${name}`));
  LAZY[name] = loadJSON(path).then((rows) => {
    DATA[name] = rows;
    return rows;
  });
  LAZY[name].catch(() => { delete LAZY[name]; });
  return LAZY[name];
}

export function getData() {
  return DATA;
}

/** Distinct values of `field` (default `.region`) in any list of records. */
export function getRegions(list, field = 'region') {
  return [...new Set(list.map((x) => x[field]))].sort();
}

/** Distinct continents/regions present in the country dataset (back-compat wrapper). */
export function getContinents() {
  return getRegions(DATA.countries);
}

/** Distinct subregions (e.g. "Middle East", "Central America") present in the country dataset. */
export function getSubregions() {
  return getRegions(DATA.countries, 'subregion');
}

/** Flag image URL from flagcdn (public, no key). Falls back gracefully. */
export function flagUrl(iso2, size = 'w320') {
  return `https://flagcdn.com/${size}/${iso2.toLowerCase()}.png`;
}

/**
 * Historic-flag image URL via Wikimedia Commons' stable `Special:FilePath`
 * endpoint. It 302-redirects to the current upload; the `width` query returns a
 * rasterized thumbnail (works for both SVG and raster sources), so we never have
 * to deal with Commons' hashed thumbnail paths.
 */
export function historicFlagUrl(filename, width = 320) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

/** US/Mexico/Canada state-or-province flag image URL, same stable Wikimedia Commons endpoint as historicFlagUrl. */
export function stateFlagUrl(filename, width = 320) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

/** Religious-symbol image URL, same stable Wikimedia Commons endpoint as historicFlagUrl. */
export function symbolImageUrl(filename, width = 320) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

// ---- interactive map SVGs (lazy-loaded) -------------------------------------
// The world map is ~1MB, so the map SVGs are fetched on demand the first time a
// click-the-map mode starts — not at app startup. Each is cached after loading.
const MAPS = {}; // name ('world'|'usa'|'mexico'|'canada') -> { svgText, regions:{id:name} }

/** Fetch + parse a bundled map SVG once. Safe to call repeatedly — the
 *  in-flight promise is cached, so rapid double-clicks share one fetch. */
export function loadMap(name) {
  if (MAPS[name]) return MAPS[name];
  MAPS[name] = (async () => {
    const res = await fetch(`assets/maps/${name}.svg`);
    if (!res.ok) throw new Error(`Failed to load map ${name}: ${res.status}`);
    const svgText = await res.text();
    return { svgText, regions: parseSvgRegions(svgText) };
  })();
  // A failed fetch must not poison the cache for retries.
  MAPS[name].catch(() => { delete MAPS[name]; });
  return MAPS[name];
}

/** All maps loaded so far, keyed by name. */
export function getMaps() {
  return MAPS;
}
