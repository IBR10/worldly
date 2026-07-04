// maps.js — the question-generation engine for the click-the-map modes.
//
// Mirrors quiz.js but for "where is X? click it on the map" questions. Each map
// mode is backed by a bundled inline SVG (assets/maps/*.svg) whose <path>
// elements carry a stable `id` (ISO / postal code) and an `aria-label` (name).
// Like quiz.js / srs.js it is pure (no DOM, no fetch) so the Node test suite can
// exercise it directly — the SVG text and parsed region tables are passed in.

import { learnMoreFor, shuffle, sampleDistinct } from './quiz.js';

// Each mode names the dataset slice it draws from and the SVG that backs it.
// "reverse" modes highlight a region and ask the player to NAME it (multiple
// choice) instead of clicking it — same pool/SVG, opposite question direction.
export const MAP_MODES = {
  map_country: { label: 'Find the Country', source: 'country', svg: 'world' },
  map_us: { label: 'Find the US State', source: 'us', svg: 'usa' },
  map_mx: { label: 'Find the Mexican State', source: 'mx', svg: 'mexico' },
  map_country_reverse: { label: 'Name the Country', source: 'country', svg: 'world', reverse: true },
  map_us_reverse: { label: 'Name the US State', source: 'us', svg: 'usa', reverse: true },
  map_mx_reverse: { label: 'Name the Mexican State', source: 'mx', svg: 'mexico', reverse: true },
  // Flag ↔ map crossovers (world map only — states have no flags in our data):
  // see a flag → click its country; see a highlighted country → pick its flag.
  map_flag_country: { label: 'Flag → Find on Map', source: 'country', svg: 'world', flagPrompt: true },
  map_country_flag: { label: 'Map → Pick the Flag', source: 'country', svg: 'world', reverse: true, flagChoices: true },
};

export const ALL_MAP_MODES = Object.keys(MAP_MODES);

/**
 * Parse an @svg-maps SVG into an { id: name } table. Each interactive region is
 * a `<path id="xx" aria-label="Name" .../>` — the two attributes can appear in
 * either order, so we read them independently from each <path> tag.
 */
export function parseSvgRegions(svgText) {
  const regions = {};
  const tags = svgText.match(/<path\b[^>]*>/g) || [];
  for (const tag of tags) {
    const id = tag.match(/\bid="([^"]+)"/);
    const name = tag.match(/\baria-label="([^"]+)"/);
    if (id && name) regions[id[1]] = name[1];
  }
  return regions;
}

/** Lowercase + strip diacritics so "Nuevo León" matches "nuevo leon". */
export function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Find the SVG path id for a dataset record under a given map mode.
 * Countries join by ISO-3166 alpha-2 code; states join by (accent-folded) name.
 * Returns null when the region isn't present in the SVG.
 */
export function regionIdFor(mode, source, regions) {
  // All country-sourced modes (incl. the flag↔map crossovers) join by iso2.
  if (MAP_MODES[mode]?.source === 'country') {
    if (!source.iso2) return null;
    const id = source.iso2.toLowerCase();
    return regions[id] ? id : null;
  }
  const target = normalizeName(source.name);
  for (const id in regions) {
    if (normalizeName(regions[id]) === target) return id;
  }
  return null;
}

/**
 * Build the askable items for the given map modes. Only regions present in BOTH
 * the dataset and the backing SVG are included, so every question is clickable.
 * @param {object} data          loaded datasets
 * @param {object} regionsByMap  { world, usa, mexico } → { id: name } tables
 * @param {object} cfg           { modes }
 */
export function buildMapPool(data, regionsByMap, { modes = ALL_MAP_MODES } = {}) {
  const pool = [];
  // Keyed by the dataset slice (`source`), so forward and reverse modes share it.
  const lists = {
    country: { list: data.countries, region: (c) => c.region },
    us: { list: data.usStates, region: () => 'North America' },
    mx: { list: data.mxStates, region: () => 'North America' },
  };

  for (const mode of modes) {
    const def = MAP_MODES[mode];
    if (!def) continue;
    const cfg = lists[def.source];
    const regions = regionsByMap[def.svg];
    if (!cfg || !regions) continue;
    for (const source of cfg.list) {
      const targetId = regionIdFor(mode, source, regions);
      if (!targetId) continue;
      pool.push({
        id: `${mode}:${source.name}`,
        mode,
        reverse: !!def.reverse,
        region: cfg.region(source),
        source,
        targetId,
        svg: def.svg,
      });
    }
  }
  return pool;
}

const PROMPTS = {
  map_country: (n) => `Where is ${n}? Click the country on the map.`,
  map_us: (n) => `Where is ${n}? Click the U.S. state on the map.`,
  map_mx: (n) => `Where is ${n}? Click the Mexican state on the map.`,
};

const REVERSE_PROMPTS = {
  map_country: 'Which country is highlighted on the map?',
  map_us: 'Which U.S. state is highlighted on the map?',
  map_mx: 'Which Mexican state is highlighted on the map?',
};

/**
 * Turn one pool item into a full map question (analogous to quiz.js#makeQuestion).
 * Forward modes ask "click where X is"; reverse modes highlight the region and
 * offer multiple-choice names (needs `data` + `rng` to build the distractors).
 */
export function makeMapQuestion(item, { data = null, rng = Math.random, choices = 4 } = {}) {
  const c = item.source;
  const def = MAP_MODES[item.mode] || {};
  const base = item.mode.replace('_reverse', '');
  const isCountry = def.source === 'country';
  const q = {
    id: item.id,
    category: item.mode,
    region: item.region,
    answer: c.name,
    targetId: item.targetId,
    svg: item.svg,
    funFact: c.funFact,
    learnMore: learnMoreFor(c, isCountry),
    source: c,
  };
  if (item.reverse) {
    const listBySource = { country: data?.countries, us: data?.usStates, mx: data?.mxStates };
    const sourceKey = MAP_MODES[item.mode]?.source;
    const names = (listBySource[sourceKey] || []).map((x) => x.name);
    const distractors = sampleDistinct(names, c.name, choices - 1, rng);
    q.reverse = true;
    q.highlightId = item.targetId;
    q.prompt = REVERSE_PROMPTS[base] || 'Which region is highlighted?';
    q.choices = shuffle([c.name, ...distractors], rng);
    if (def.flagChoices) {
      // The renderer shows the options as flag images; answers stay keyed by
      // name so the shared answer() flow needs no changes.
      const iso = new Map((data?.countries || []).map((x) => [x.name, x.iso2]));
      q.flagChoices = true;
      q.flagByName = Object.fromEntries(q.choices.map((n) => [n, iso.get(n)]));
      q.prompt = 'A country is highlighted on the map — which flag flies there?';
    }
  } else {
    q.prompt = (PROMPTS[item.mode] || PROMPTS.map_country)(c.name);
    if (def.flagPrompt) {
      q.flagIso = c.iso2;
      q.prompt = 'Which country flies this flag? Click it on the map.';
    }
  }
  return q;
}
