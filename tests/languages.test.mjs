// Unit tests for js/languages.js — the pure bucketing/paint logic behind the
// Language Map. Like the other engine tests these use a small synthetic dataset
// that mirrors the real data/greetings.json shape; the real file is checked
// separately by tests/data-integrity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_BUCKETS,
  NO_DATA,
  TOP_LANGUAGE_COUNT,
  ALL_REGION_CLASSES,
  bucketForFamily,
  classForBucket,
  familyLegend,
  topLanguages,
  languageLegend,
  regionClassesFor,
} from '../js/languages.js';

const rows = [
  { iso2: 'ES', language: 'Spanish', family: 'romance' },
  { iso2: 'MX', language: 'Spanish', family: 'romance' },
  { iso2: 'FR', language: 'French', family: 'romance' },
  { iso2: 'GB', language: 'English', family: 'germanic' },
  { iso2: 'US', language: 'English', family: 'germanic' },
  { iso2: 'DE', language: 'German', family: 'germanic' },
  { iso2: 'JP', language: 'Japanese', family: 'japonic' },
  { iso2: 'KR', language: 'Korean', family: 'koreanic' },
  { iso2: 'TH', language: 'Thai', family: 'kra-dai' },
  { iso2: 'GR', language: 'Greek', family: 'other-indo-european' },
  { iso2: 'FI', language: 'Finnish', family: 'uralic' },
  { iso2: 'HT', language: 'Haitian Creole', family: 'creole' },
  { iso2: 'BV', language: '—', family: 'none', uninhabited: true },
];

test('every bucket has a unique key, label and lf- class name', () => {
  const keys = FAMILY_BUCKETS.map((b) => b.key);
  const classes = FAMILY_BUCKETS.map((b) => b.className);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(classes).size, classes.length);
  for (const b of FAMILY_BUCKETS) {
    assert.match(b.className, /^lf-[a-z-]+$/);
    assert.ok(b.label.length > 0);
    assert.ok(b.families.length > 0);
  }
  assert.ok(!classes.includes(NO_DATA.className), 'No data is not a bucket');
});

test('no family value is claimed by two buckets', () => {
  const seen = new Set();
  for (const b of FAMILY_BUCKETS) {
    for (const f of b.families) {
      assert.ok(!seen.has(f), `${f} is in more than one bucket`);
      seen.add(f);
    }
  }
});

test('bucketForFamily maps each declared family to its own bucket', () => {
  for (const b of FAMILY_BUCKETS) {
    for (const f of b.families) assert.equal(bucketForFamily(f), b.key);
  }
});

test("bucketForFamily sends 'none', empty and unknown values somewhere sensible", () => {
  assert.equal(bucketForFamily('none'), NO_DATA.key);
  assert.equal(bucketForFamily(''), NO_DATA.key);
  assert.equal(bucketForFamily(undefined), NO_DATA.key);
  // A family added to the data before it is added here must still paint, rather
  // than silently leaving a hole in the map.
  assert.equal(bucketForFamily('tupian'), 'other');
});

test('classForBucket round-trips, and an unknown key degrades to No data', () => {
  for (const b of FAMILY_BUCKETS) assert.equal(classForBucket(b.key), b.className);
  assert.equal(classForBucket(NO_DATA.key), NO_DATA.className);
  assert.equal(classForBucket('not-a-bucket'), NO_DATA.className);
});

test('familyLegend counts regions, orders by size, and puts No data last', () => {
  const legend = familyLegend(rows);
  assert.deepEqual(legend.map((x) => x.label), [
    // Three buckets tie at 3 regions, so the label decides the order.
    'East & Southeast Asian', // 3 — JP + KR + TH
    'Germanic',               // 3
    'Romance',                // 3
    'Other families',         // 2 — GR + FI
    'Creole & pidgin',        // 1
    'No permanent population',
  ]);
  assert.deepEqual(legend.map((x) => x.count), [3, 3, 3, 2, 1, 1]);
  assert.equal(legend.at(-1).className, NO_DATA.className);
});

test('familyLegend omits buckets with no regions', () => {
  const legend = familyLegend([{ iso2: 'ES', language: 'Spanish', family: 'romance' }]);
  assert.deepEqual(legend.map((x) => x.key), ['romance']);
});

test('familyLegend on an empty dataset is empty, not a row of zeroes', () => {
  assert.deepEqual(familyLegend([]), []);
});

test('topLanguages ranks by region count and breaks ties alphabetically', () => {
  assert.deepEqual(topLanguages(rows, 2), ['English', 'Spanish']);
  // Everything below the top two has exactly one region, so the language name
  // decides — and it must, or the palette would shuffle on any data edit.
  assert.deepEqual(topLanguages(rows, 5), ['English', 'Spanish', 'Finnish', 'French', 'German']);
});

test('topLanguages excludes uninhabited regions and clamps n', () => {
  assert.ok(!topLanguages(rows, 99).includes('—'));
  assert.equal(topLanguages(rows, 99).length, 10); // 10 distinct inhabited languages
  assert.deepEqual(topLanguages(rows, 0), []);
  assert.deepEqual(topLanguages(rows, -3), []);
});

test('languageLegend lists top languages, then Other, then No data', () => {
  const legend = languageLegend(rows, 2);
  assert.deepEqual(legend.map((x) => x.label), [
    'English', 'Spanish', 'Other languages', 'No permanent population',
  ]);
  assert.deepEqual(legend.map((x) => x.count), [2, 2, 8, 1]);
  assert.deepEqual(legend.slice(0, 2).map((x) => x.className), ['lg-1', 'lg-2']);
});

test('languageLegend omits Other when every language is in the top n', () => {
  const two = [
    { iso2: 'ES', language: 'Spanish', family: 'romance' },
    { iso2: 'GB', language: 'English', family: 'germanic' },
  ];
  assert.deepEqual(languageLegend(two, 5).map((x) => x.label), ['English', 'Spanish']);
});

test('regionClassesFor keys by lowercase svg id in family mode', () => {
  const classes = regionClassesFor(rows, 'family');
  assert.equal(classes.es, 'lf-romance');
  assert.equal(classes.gb, 'lf-germanic');
  assert.equal(classes.jp, 'lf-east-asian');
  assert.equal(classes.th, 'lf-east-asian');
  assert.equal(classes.bv, NO_DATA.className);
  assert.equal(classes.ES, undefined, 'ids are lowercased, matching world.svg');
  assert.equal(Object.keys(classes).length, rows.length);
});

test('regionClassesFor gives each top language its own slot class', () => {
  const classes = regionClassesFor(rows, 'language', 2);
  assert.equal(classes.gb, 'lg-1');
  assert.equal(classes.us, 'lg-1', 'colour follows the language, not the region');
  assert.equal(classes.es, 'lg-2');
  assert.equal(classes.mx, 'lg-2');
  assert.equal(classes.fr, 'lg-other');
  assert.equal(classes.bv, NO_DATA.className);
});

test('regionClassesFor never emits a family class in language mode', () => {
  const classes = regionClassesFor(rows, 'language');
  for (const cls of Object.values(classes)) {
    assert.ok(cls === NO_DATA.className || cls.startsWith('lg-'), `${cls} is not a language-mode class`);
  }
});

test('regionClassesFor skips rows with no iso2 rather than writing an undefined key', () => {
  const classes = regionClassesFor([{ language: 'Spanish', family: 'romance' }], 'family');
  assert.deepEqual(classes, {});
});

test('ALL_REGION_CLASSES covers every class either mode can emit', () => {
  const emitted = new Set([
    ...Object.values(regionClassesFor(rows, 'family')),
    ...Object.values(regionClassesFor(rows, 'language')),
  ]);
  for (const cls of emitted) assert.ok(ALL_REGION_CLASSES.includes(cls), `${cls} would never be cleared`);
  assert.equal(ALL_REGION_CLASSES.length, FAMILY_BUCKETS.length + 1 + TOP_LANGUAGE_COUNT + 1);
});
