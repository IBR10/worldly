// Map-engine tests — run with `npm test` (node --test).
// These exercise the pure, DOM-free parts of the click-the-map modes (maps.js):
// SVG region parsing, the data↔SVG join, question generation and the picker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSvgRegions, normalizeName, regionIdFor, buildMapPool, ALL_MAP_MODES,
  makeMapQuestion,
} from '../js/maps.js';

// Tiny SVGs that mirror the real @svg-maps shape (both attribute orderings).
const worldSvg = `
<svg viewBox="0 0 100 100">
  <path d="m0" aria-label="Japan" id="jp" />
  <path id="fr" aria-label="France" d="m1" />
  <path d="m2" id="br" aria-label="Brazil" />
</svg>`;
const usaSvg = `
<svg viewBox="0 0 100 100">
  <path id="co" aria-label="Colorado" d="m0" />
  <path id="ca" aria-label="California" d="m1" />
</svg>`;
const mxSvg = `
<svg viewBox="0 0 100 100">
  <path id="jal" aria-label="Jalisco" d="m0" />
  <path id="nle" aria-label="Nuevo León" d="m1" />
</svg>`;

const data = {
  countries: [
    { name: 'Japan', iso2: 'JP', capital: 'Tokyo', region: 'Asia', funFact: 'Islands.', wiki: 'https://w/Japan' },
    { name: 'France', iso2: 'FR', capital: 'Paris', region: 'Europe', funFact: 'Visited.', wiki: 'https://w/France' },
    { name: 'Brazil', iso2: 'BR', capital: 'Brasília', region: 'South America', funFact: 'Amazon.', wiki: 'https://w/Brazil' },
    // No path in our tiny SVG → must be excluded from any map pool.
    { name: 'Atlantis', iso2: 'AT', capital: 'Nowhere', region: 'Ocean', funFact: 'Myth.', wiki: 'https://w/Atlantis' },
  ],
  usStates: [{ name: 'Colorado', capital: 'Denver', region: 'West', funFact: 'Mile high.', wiki: 'https://w/CO' }],
  mxStates: [{ name: 'Nuevo León', capital: 'Monterrey', region: 'North', funFact: 'Industry.', wiki: 'https://w/NL' }],
};

const regionsByMap = {
  world: parseSvgRegions(worldSvg),
  usa: parseSvgRegions(usaSvg),
  mexico: parseSvgRegions(mxSvg),
};

test('parseSvgRegions reads id→name regardless of attribute order', () => {
  const r = parseSvgRegions(worldSvg);
  assert.equal(r.jp, 'Japan');
  assert.equal(r.fr, 'France');
  assert.equal(r.br, 'Brazil');
  assert.equal(Object.keys(r).length, 3);
});

test('normalizeName folds case and accents', () => {
  assert.equal(normalizeName('Nuevo León'), normalizeName('nuevo leon'));
  assert.equal(normalizeName('Yucatán'), 'yucatan');
  assert.equal(normalizeName('  Jalisco '), 'jalisco');
});

test('regionIdFor joins countries by iso2 and states by name', () => {
  assert.equal(regionIdFor('map_country', data.countries[0], regionsByMap.world), 'jp');
  assert.equal(regionIdFor('map_us', data.usStates[0], regionsByMap.usa), 'co');
  assert.equal(regionIdFor('map_mx', data.mxStates[0], regionsByMap.mexico), 'nle');
  // No matching path → null.
  assert.equal(regionIdFor('map_country', data.countries[3], regionsByMap.world), null);
});

test('buildMapPool includes only SVG-present regions and covers all modes', () => {
  const countryPool = buildMapPool(data, regionsByMap, { modes: ['map_country'] });
  const names = countryPool.map((p) => p.source.name).sort();
  assert.deepEqual(names, ['Brazil', 'France', 'Japan']); // Atlantis excluded
  assert.ok(countryPool.every((p) => p.targetId && p.svg === 'world'));
  assert.ok(countryPool.every((p) => p.id.startsWith('map_country:')));

  const all = buildMapPool(data, regionsByMap, { modes: ALL_MAP_MODES });
  assert.equal(all.filter((p) => p.mode === 'map_country').length, 3);
  assert.equal(all.filter((p) => p.mode === 'map_us').length, 1);
  assert.equal(all.filter((p) => p.mode === 'map_mx').length, 1);
});

test('makeMapQuestion carries target id, answer and learn-more links', () => {
  const item = buildMapPool(data, regionsByMap, { modes: ['map_country'] })
    .find((p) => p.source.name === 'Japan');
  const q = makeMapQuestion(item);
  assert.equal(q.answer, 'Japan');
  assert.equal(q.targetId, 'jp');
  assert.equal(q.svg, 'world');
  assert.equal(q.category, 'map_country');
  assert.match(q.prompt, /Japan/);
  assert.ok(q.funFact.length > 0);
  assert.ok(q.learnMore.some((l) => l.label === 'Wikipedia'));
});

test('buildMapPool covers reverse modes and flags them', () => {
  const all = buildMapPool(data, regionsByMap, { modes: ALL_MAP_MODES });
  assert.equal(all.filter((p) => p.mode === 'map_country_reverse').length, 3);
  assert.equal(all.filter((p) => p.mode === 'map_us_reverse').length, 1);
  assert.equal(all.filter((p) => p.mode === 'map_mx_reverse').length, 1);
  assert.ok(all.filter((p) => p.reverse).length >= 5);
});

test('regionIdFor resolves reverse modes like their forward twin', () => {
  assert.equal(regionIdFor('map_country_reverse', data.countries[0], regionsByMap.world), 'jp');
  assert.equal(regionIdFor('map_us_reverse', data.usStates[0], regionsByMap.usa), 'co');
});

test('buildMapPool covers the flag↔map modes (world map only)', () => {
  const flagToMap = buildMapPool(data, regionsByMap, { modes: ['map_flag_country'] });
  assert.equal(flagToMap.length, 3); // Japan, France, Brazil — Atlantis has no path
  assert.ok(flagToMap.every((p) => p.svg === 'world' && !p.reverse));

  const mapToFlag = buildMapPool(data, regionsByMap, { modes: ['map_country_flag'] });
  assert.equal(mapToFlag.length, 3);
  assert.ok(mapToFlag.every((p) => p.svg === 'world' && p.reverse));
});

test('makeMapQuestion (map_flag_country) shows a flag and asks for a map click', () => {
  const item = buildMapPool(data, regionsByMap, { modes: ['map_flag_country'] })
    .find((p) => p.source.name === 'France');
  const q = makeMapQuestion(item);
  assert.ok(!q.reverse, 'forward click mode');
  assert.equal(q.flagIso, 'FR', 'carries the iso2 so the UI can show the flag');
  assert.equal(q.targetId, 'fr');
  assert.equal(q.answer, 'France');
  assert.match(q.prompt, /flag/i);
  assert.match(q.prompt, /click/i);
});

test('makeMapQuestion (map_country_flag) highlights a country and offers flag choices', () => {
  const item = buildMapPool(data, regionsByMap, { modes: ['map_country_flag'] })
    .find((p) => p.source.name === 'Japan');
  const q = makeMapQuestion(item, { data, rng: () => 0.5, choices: 4 });
  assert.equal(q.reverse, true);
  assert.equal(q.highlightId, 'jp');
  assert.equal(q.answer, 'Japan');
  assert.equal(q.flagChoices, true, 'renderer shows flags instead of names');
  assert.ok(q.choices.includes('Japan'));
  for (const name of q.choices) {
    assert.match(q.flagByName[name] || '', /^[A-Z]{2}$/, `every choice has an iso2 (${name})`);
  }
  assert.match(q.prompt, /flag/i);
});

test('makeMapQuestion (reverse) highlights the region and offers multiple choice', () => {
  const item = buildMapPool(data, regionsByMap, { modes: ['map_country_reverse'] })
    .find((p) => p.source.name === 'Japan');
  const q = makeMapQuestion(item, { data, rng: () => 0.5, choices: 4 });
  assert.equal(q.reverse, true);
  assert.equal(q.answer, 'Japan');
  assert.equal(q.highlightId, 'jp');
  assert.equal(q.category, 'map_country_reverse');
  assert.ok(Array.isArray(q.choices) && q.choices.includes('Japan'));
  assert.equal(new Set(q.choices).size, q.choices.length, 'choices are unique');
  assert.match(q.prompt, /highlighted/);
});
