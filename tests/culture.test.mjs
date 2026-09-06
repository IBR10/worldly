// Unit tests for js/culture.js — the pure lookup helpers behind the country
// guide pages. Synthetic fixtures, as elsewhere; the real data/culture/*.json
// files are checked by tests/data-integrity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CULTURE_DATASETS, CULTURE_KEYS, datasetKeyForRegion, cultureFor, cultureSections, initialsFor,
} from '../js/culture.js';

test('every countries.json region maps to its own dataset key', () => {
  const regions = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];
  assert.deepEqual(Object.keys(CULTURE_DATASETS).sort(), [...regions].sort());
  assert.equal(new Set(CULTURE_KEYS).size, CULTURE_KEYS.length);
  for (const r of regions) assert.equal(datasetKeyForRegion(r), CULTURE_DATASETS[r]);
});

test('an unknown region yields null, not a throw', () => {
  // A page for a country in an unrecognised region must still render; null is
  // the "no deep dive" signal the screen already handles.
  assert.equal(datasetKeyForRegion('Antarctica'), null);
  assert.equal(datasetKeyForRegion(''), null);
  assert.equal(datasetKeyForRegion(undefined), null);
});

const rows = [
  { iso2: 'JP', people: [{ name: 'A' }], events: [{ year: '1868' }] },
  { iso2: 'KR', people: [] },
];

test('cultureFor matches on iso2 regardless of case', () => {
  assert.equal(cultureFor(rows, 'JP').iso2, 'JP');
  assert.equal(cultureFor(rows, 'jp').iso2, 'JP');
});

test('cultureFor returns null for a miss or a bad argument', () => {
  assert.equal(cultureFor(rows, 'ZZ'), null);
  assert.equal(cultureFor(rows, ''), null);
  assert.equal(cultureFor(rows, undefined), null);
  assert.equal(cultureFor(null, 'JP'), null);
  assert.equal(cultureFor(undefined, 'JP'), null);
});

test('cultureSections gives empty collections for a missing entry', () => {
  const s = cultureSections(null);
  assert.deepEqual(s, { people: [], events: [], culture: [], talkAbout: [], avoid: '', note: '' });
});

test('cultureSections tolerates a partially authored entry', () => {
  const s = cultureSections({ people: [{ name: 'A' }], avoid: '', note: 'contested' });
  assert.equal(s.people.length, 1);
  assert.deepEqual(s.events, []);
  assert.equal(s.avoid, '');
  assert.equal(s.note, 'contested');
});

test('cultureSections ignores fields of the wrong type', () => {
  const s = cultureSections({ people: 'nope', avoid: 42, talkAbout: null });
  assert.deepEqual(s.people, []);
  assert.deepEqual(s.talkAbout, []);
  assert.equal(s.avoid, '');
});

test('initialsFor takes the first and last name', () => {
  assert.equal(initialsFor('Katsushika Hokusai'), 'KH');
  assert.equal(initialsFor('Gabriel García Márquez'), 'GM');
  assert.equal(initialsFor('Pelé'), 'PE');
  assert.equal(initialsFor('  Confucius  '), 'CO');
});

test('initialsFor never throws on empty input', () => {
  assert.equal(initialsFor(''), '?');
  assert.equal(initialsFor('   '), '?');
  assert.equal(initialsFor(null), '?');
  assert.equal(initialsFor(undefined), '?');
});
