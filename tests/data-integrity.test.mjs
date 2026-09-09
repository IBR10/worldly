// Integrity checks over the real data/ files.
//
// A deliberate departure from the rule that unit tests use synthetic fixtures.
// The reason: data/ is hand-authored, ESLint ignores it, and nothing else in CI
// validates it — so a typo'd iso2, a duplicate slug or a half-written country
// entry ships silently and only shows up as a hole in the map or an empty
// section on a page. Reading files with node:fs keeps this DOM-free and
// fetch-free, so it still runs under plain `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FAMILY_BUCKETS, NO_DATA } from '../js/languages.js';
import { CULTURE_DATASETS } from '../js/culture.js';
import { ICON_NAMES } from '../js/icons.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(`${root}${p}`, 'utf8'));

const countries = read('data/countries.json');
const achievements = read('data/achievements.json');
const usStates = read('data/us_states.json');
const mxStates = read('data/mexico_states.json');
const caStates = read('data/canada_provinces.json');
const greetings = read('data/greetings.json');
const crises = read('data/crises.json');
const worldSvg = fs.readFileSync(`${root}assets/maps/world.svg`, 'utf8');
const svgIds = new Set([...worldSvg.matchAll(/id="([^"]*)"/g)].map((m) => m[1]));

// Mirrors slugify() in main.js, which turns a name into its public URL.
const slugify = (s) => String(s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"']+$/.test(u);

const cultureFiles = Object.entries(CULTURE_DATASETS).map(([region, key]) => {
  const path = `data/culture/${region.toLowerCase().replace(/\s+/g, '-')}.json`;
  const exists = fs.existsSync(`${root}${path}`);
  return { region, key, path, exists, rows: exists ? read(path) : [] };
});

// ---- countries.json ---------------------------------------------------------

test('every country has the full schema and no stray fields', () => {
  const KEYS = ['name', 'iso2', 'capital', 'region', 'subregion', 'population',
    'language', 'religion', 'currency', 'funFact', 'history', 'wiki'];
  for (const c of countries) {
    for (const k of KEYS) assert.ok(c[k] !== undefined && c[k] !== '', `${c.iso2 || '??'} is missing ${k}`);
    const extra = Object.keys(c).filter((k) => !KEYS.includes(k) && k !== 'note');
    assert.deepEqual(extra, [], `${c.iso2} has unexpected keys`);
    assert.match(c.iso2, /^[A-Z]{2}$/, `${c.name} iso2`);
    assert.equal(typeof c.population, 'number', `${c.iso2} population`);
    assert.ok(isHttps(c.wiki), `${c.iso2} wiki is not an https URL`);
  }
});

test('country iso2 codes and URL slugs are unique', () => {
  const iso = countries.map((c) => c.iso2);
  assert.equal(new Set(iso).size, iso.length, 'duplicate iso2');
  // slugify(name) is the /country/:slug key; a collision makes one page
  // unreachable, silently.
  const slugs = countries.map((c) => slugify(c.name));
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate country slug');
  for (const s of slugs) assert.ok(s.length > 0);
});

test('every country has a region on the world map', () => {
  const missing = countries.filter((c) => !svgIds.has(c.iso2.toLowerCase()));
  assert.deepEqual(missing.map((c) => c.iso2), [], 'countries with no world.svg path');
});

test('a language value is never just the country name', () => {
  // Nauru/Kiribati were stored this way and would have shown up in the map key
  // as if they were languages.
  const bad = countries.filter((c) => c.language.toLowerCase() === c.name.toLowerCase());
  assert.deepEqual(bad.map((c) => c.iso2), []);
});

// ---- greetings.json ---------------------------------------------------------

test('every world.svg region has a greetings entry — the map has no holes', () => {
  const covered = new Set(greetings.map((g) => g.iso2.toLowerCase()));
  const holes = [...svgIds].filter((id) => id !== 'undefined' && !covered.has(id));
  assert.deepEqual(holes, [], 'map regions with no greeting row');
});

test('greetings ids are unique and every one is a real map region', () => {
  const ids = greetings.map((g) => g.iso2.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, 'duplicate greeting iso2');
  const orphans = ids.filter((id) => !svgIds.has(id));
  assert.deepEqual(orphans, [], 'greetings for regions the map does not draw');
});

test('every greeting family is a value some bucket claims', () => {
  const known = new Set([...FAMILY_BUCKETS.flatMap((b) => b.families), 'none']);
  const unknown = [...new Set(greetings.map((g) => g.family))].filter((f) => !known.has(f));
  assert.deepEqual(unknown, [], 'family values no bucket claims');
});

test('every inhabited region can actually be greeted', () => {
  for (const g of greetings) {
    if (g.uninhabited) {
      assert.equal(g.family, 'none', `${g.iso2} is uninhabited but has a family`);
      continue;
    }
    assert.ok(g.hello, `${g.iso2} has no hello`);
    assert.ok(g.pron, `${g.iso2} has no pronunciation`);
    assert.ok(g.language, `${g.iso2} has no language`);
    assert.notEqual(g.family, NO_DATA.key, `${g.iso2} is inhabited but classed as no-data`);
    // langCode drives the speech synthesis voice pick, so a malformed one
    // silently degrades every 🔊 button for that country.
    assert.match(g.langCode, /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, `${g.iso2} langCode "${g.langCode}"`);
    assert.ok(Array.isArray(g.alsoTry) && g.alsoTry.length >= 1, `${g.iso2} alsoTry`);
    for (const p of g.alsoTry) {
      for (const k of ['en', 'local', 'pron']) assert.ok(p[k], `${g.iso2} alsoTry.${k}`);
    }
  }
});

test('every country in the dataset has a greeting', () => {
  const covered = new Set(greetings.map((g) => g.iso2));
  const missing = countries.filter((c) => !covered.has(c.iso2));
  assert.deepEqual(missing.map((c) => c.iso2), []);
});

// ---- crises.json ------------------------------------------------------------

test('current crises are dated and historical ones have an era', () => {
  for (const e of crises) {
    assert.ok(e.title && e.country && e.iso2, `${e.title || '??'} is missing an identifier`);
    assert.ok(Array.isArray(e.summary) && e.summary.length >= 2, `${e.title} summary`);
    if ((e.period || 'current') === 'current') {
      assert.ok(e.asOf, `${e.title} has no asOf — the reader cannot tell how stale it is`);
      assert.ok(Number.isFinite(Date.parse(`1 ${e.asOf}`)), `${e.title} asOf "${e.asOf}" is unparseable`);
    } else {
      assert.ok(e.era, `${e.title} is historical but has no era`);
    }
    for (const l of e.links || []) assert.ok(isHttps(l.url), `${e.title} link ${l.label}`);
  }
});

test('crisis titles are unique — the title is the URL key', () => {
  const slugs = crises.map((e) => slugify(e.title));
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate crisis slug');
});

// ---- culture/*.json ---------------------------------------------------------

test('culture files hold only countries from their own region', () => {
  const byIso = new Map(countries.map((c) => [c.iso2, c]));
  for (const f of cultureFiles) {
    if (!f.exists) continue;
    for (const row of f.rows) {
      const c = byIso.get(row.iso2);
      assert.ok(c, `${f.path}: ${row.iso2} is not a country in the dataset`);
      assert.equal(c.region, f.region, `${row.iso2} is in ${f.path} but its region is ${c.region}`);
    }
    const ids = f.rows.map((r) => r.iso2);
    assert.equal(new Set(ids).size, ids.length, `${f.path} has duplicate entries`);
  }
});

test('each authored culture entry meets the content contract', () => {
  // Asserted only over entries that exist, so a half-finished region is a
  // smaller map rather than a red build. The completeness check is separate.
  for (const f of cultureFiles) {
    for (const row of f.rows) {
      const where = `${f.path}:${row.iso2}`;
      assert.equal(row.people?.length, 5, `${where} needs exactly 5 people`);
      for (const p of row.people) {
        for (const k of ['name', 'field', 'why', 'wiki']) assert.ok(p[k], `${where} person "${p.name}" missing ${k}`);
        assert.ok(isHttps(p.wiki), `${where} person "${p.name}" wiki`);
      }
      assert.ok(row.events?.length >= 3 && row.events.length <= 5, `${where} needs 3–5 events`);
      for (const e of row.events) {
        for (const k of ['year', 'title', 'what']) assert.ok(e[k], `${where} event "${e.title}" missing ${k}`);
        if (e.wiki) assert.ok(isHttps(e.wiki), `${where} event "${e.title}" wiki`);
      }
      assert.ok(row.culture?.length >= 4 && row.culture.length <= 6, `${where} needs 4–6 culture rows`);
      for (const c of row.culture) {
        for (const k of ['icon', 'label', 'text']) assert.ok(c[k], `${where} culture row missing ${k}`);
      }
      assert.equal(row.talkAbout?.length, 3, `${where} needs exactly 3 conversation starters`);
      for (const t of row.talkAbout) assert.ok(typeof t === 'string' && t.length > 10, `${where} talkAbout too short`);
      assert.ok(row.avoid, `${where} has no "tread carefully" note`);
    }
  }
});

test('every country has a culture entry', () => {
  // Tightened once all six regions are authored; until then it reports how far
  // the content has got rather than failing the build.
  const authored = new Set(cultureFiles.flatMap((f) => f.rows.map((r) => r.iso2)));
  const missing = countries.filter((c) => !authored.has(c.iso2)).map((c) => `${c.iso2} ${c.name}`);
  assert.deepEqual(missing, [], `countries with no culture entry (${missing.length})`);
});

test('every achievement names an icon the app can actually draw', () => {
  // achievements.json used to carry an emoji per badge. It now carries a key
  // into js/icons.js, and an unknown key draws nothing — a blank badge, with no
  // error anywhere. This is the only thing that would catch a typo in it.
  for (const a of achievements) {
    assert.ok(ICON_NAMES.includes(a.icon), `${a.id} icon "${a.icon}" is a real icon`);
  }
});

test('every state and province carries the flag its quiz question shows', () => {
  // The three state/province capital modes render `flag` through the Wikimedia
  // Commons FilePath endpoint. A missing or malformed filename is a broken image
  // on a real question, which nothing else in the suite would notice.
  for (const [label, rows] of [['US state', usStates], ['Mexican state', mxStates], ['Canadian province', caStates]]) {
    for (const r of rows) {
      assert.ok(typeof r.flag === 'string' && r.flag.trim(), `${label} ${r.name} has a flag filename`);
      assert.match(r.flag, /\.(svg|png)$/i, `${label} ${r.name} flag "${r.flag}" is an image file`);
    }
  }
});
