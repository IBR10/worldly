// Unit tests for js/progressmap.js — the derivation behind the home hero map
// and the Progress dashboard. Like the other engine tests these run on a small
// synthetic dataset shaped like the real data/countries.json; the real file is
// checked separately by tests/data-integrity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTERY_CLASSES,
  splitItemId,
  countryMastery,
  masteryClasses,
  discoveryStats,
  continentClass,
} from '../js/progressmap.js';

const countries = [
  { name: 'Japan', iso2: 'JP', region: 'Asia' },
  { name: 'Peru', iso2: 'PE', region: 'South America' },
  { name: 'Brazil', iso2: 'BR', region: 'South America' },
  { name: 'France', iso2: 'FR', region: 'Europe' },
  { name: 'Kenya', iso2: 'KE', region: 'Africa' },
];

test('splitItemId splits on the first colon only', () => {
  assert.deepEqual(splitItemId('capital:Japan'), { mode: 'capital', subject: 'Japan' });
  // A subject containing a colon keeps it — the mode is the part before the
  // FIRST separator, not a naive split().
  assert.deepEqual(splitItemId('flag:Cocos: Keeling'), { mode: 'flag', subject: 'Cocos: Keeling' });
});

test('splitItemId rejects ids that are not mode:subject', () => {
  for (const bad of ['', 'nocolon', ':leading', 'trailing:', null, undefined, 42, {}]) {
    assert.equal(splitItemId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('countryMastery lists every country, unknown ones at level 0', () => {
  const m = countryMastery({}, countries);
  assert.deepEqual(Object.keys(m).sort(), ['BR', 'FR', 'JP', 'KE', 'PE']);
  assert.ok(Object.values(m).every((v) => v === 0));
});

test('countryMastery maps Leitner boxes onto three visible levels', () => {
  const m = countryMastery({
    'capital:Japan': { box: 1 },       // seen
    'capital:Peru': { box: 3 },        // learned
    'capital:France': { box: 5 },      // mastered
    'capital:Kenya': { box: 0 },       // answered, never right
  }, countries);
  assert.equal(m.JP, 1);
  assert.equal(m.PE, 2);
  assert.equal(m.FR, 3);
  assert.equal(m.KE, 0);
});

test('countryMastery takes the best box across modes', () => {
  // Knowing Japan's flag and not its currency is still knowing Japan.
  const m = countryMastery({
    'currency:Japan': { box: 1 },
    'flag:Japan': { box: 5 },
    'population:Japan': { box: 2 },
  }, countries);
  assert.equal(m.JP, 3);
});

test('countryMastery ignores items that are not countries', () => {
  // US states, religions and Pokémon share the id shape but no country name.
  const m = countryMastery({
    'us_state:Texas': { box: 5 },
    'religion:Shinto': { box: 5 },
    'poke_who:Pikachu': { box: 5 },
    'capital:Atlantis': { box: 5 },
  }, countries);
  assert.ok(Object.values(m).every((v) => v === 0));
});

test('countryMastery survives a malformed or empty profile', () => {
  assert.deepEqual(countryMastery(null, null), {});
  assert.deepEqual(countryMastery(undefined, []), {});
  const m = countryMastery({ 'capital:Japan': {}, 'flag:Peru': { box: 'x' } }, countries);
  assert.equal(m.JP, 0);
  assert.equal(m.PE, 0);
});

test('masteryClasses emits lowercase svg ids and skips level 0', () => {
  const classes = masteryClasses({ JP: 3, PE: 2, FR: 1, KE: 0 });
  assert.deepEqual(classes, { jp: 'known-3', pe: 'known-2', fr: 'known-1' });
  for (const cls of Object.values(classes)) assert.ok(MASTERY_CLASSES.includes(cls));
});

test('discoveryStats counts known, mastered and per-region totals', () => {
  const mastery = { JP: 1, PE: 3, BR: 0, FR: 2, KE: 0 };
  const s = discoveryStats(mastery, countries);
  assert.equal(s.total, 5);
  assert.equal(s.known, 3);
  assert.equal(s.mastered, 1);
  const sa = s.byRegion.find((r) => r.region === 'South America');
  assert.deepEqual({ known: sa.known, total: sa.total, pct: sa.pct }, { known: 1, total: 2, pct: 50 });
  const africa = s.byRegion.find((r) => r.region === 'Africa');
  assert.equal(africa.pct, 0);
});

test('discoveryStats never rounds a partial score to 0% or 100%', () => {
  const many = Array.from({ length: 198 }, (_, i) => ({
    name: `C${i}`, iso2: `X${i}`, region: 'Asia',
  }));
  const one = discoveryStats({ X0: 1 }, many);
  assert.equal(one.pct, 1, 'one of 198 must not round away to 0%');

  const allButOne = {};
  for (let i = 1; i < 198; i++) allButOne[`X${i}`] = 1;
  assert.equal(discoveryStats(allButOne, many).pct, 99, '197 of 198 must not round up to 100%');

  const all = {};
  for (let i = 0; i < 198; i++) all[`X${i}`] = 1;
  assert.equal(discoveryStats(all, many).pct, 100);
  assert.equal(discoveryStats({}, many).pct, 0);
});

test('discoveryStats orders regions by size, then name', () => {
  const s = discoveryStats({}, countries);
  assert.equal(s.byRegion[0].region, 'South America'); // the only region with two
  assert.deepEqual(s.byRegion.slice(1).map((r) => r.region), ['Africa', 'Asia', 'Europe']);
});

test('continentClass matches the continent key in the stylesheet', () => {
  assert.equal(continentClass('South America'), 'con-south-america');
  assert.equal(continentClass('Africa'), 'con-africa');
  assert.equal(continentClass(''), 'con-');
});
