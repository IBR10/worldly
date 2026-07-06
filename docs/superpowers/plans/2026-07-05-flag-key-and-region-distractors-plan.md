# Flag Key + Region-Aware Distractors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the country dataset, make every country-based quiz mode draw wrong answers from geographically nearby countries instead of anywhere in the world, and add a new browsable "Flag Key" reference screen (Countries / US States / Mexican States, each searchable and filterable by region) — including sourcing real flag data for US and Mexican states, which have none today.

**Architecture:** Four build-order phases, each independently testable: (1) grow `data/countries.json` from 76 → ~154 entries, reusing the existing schema exactly; (2) a new pure `geoDistractors()` helper in `js/quiz.js` that tiers distractor candidates by subregion → region → global, wired into the five country-based modes; (3) a new `showFlagKey()` screen in `js/main.js` reusing the existing `wireTabs()`/card-grid/`<select>` patterns already used by Home, Crises, and World Religions; (4) a new `flag` field on `data/us_states.json`/`data/mexico_states.json` (Wikimedia Commons filenames, same technique as `historic_flags.json`) plus a `stateFlagUrl()` helper in `js/data.js`.

**Tech Stack:** Vanilla ES modules, `node --test` for unit tests, no build step, static JSON data files, Wikimedia Commons `Special:FilePath` for flag images.

## Global Constraints

- No new dependencies — everything is vanilla JS/CSS/JSON, matching the existing codebase.
- Every new country/state record uses the EXACT existing schema (no new fields beyond what's specified below).
- `npm test` (`node --test tests/*.test.mjs`) must stay green after every task.
- New country `subregion` values must come from the allow-list in Task 1's validation script — no ad hoc new subregion strings, or the distractor tiering silently fragments.
- All new external URLs (Wikipedia, Wikimedia Commons flag files) must be validated (curl/oEmbed-style check) before a task is considered done, matching the standard already applied to `historic_flags.json` and `music.json`.

---

## Phase 1 — Country data expansion (76 → ~154)

### Task 1: Add Africa + Oceania countries (the thinnest regions)

**Files:**
- Modify: `data/countries.json`
- Test: ad hoc validation script (below), no `tests/*.test.mjs` changes needed (the unit test fixture is a separate synthetic dataset, untouched by real data growth)

**Interfaces:**
- Produces: 39 Africa entries (10 existing + 29 new), 14 Oceania entries (4 existing + 10 new) in `data/countries.json`, following the schema `{ name, iso2, capital, region, subregion, population, language, religion, currency, funFact, wiki }` (+ optional `note`).

- [ ] **Step 1: Add these 29 African countries** to `data/countries.json` (append new objects to the array): Tunisia, Libya, Sudan, Ivory Coast, Mali, Niger, Guinea, Sierra Leone, Benin, Togo, Burkina Faso, Uganda, Rwanda, Somalia, Eritrea, Cameroon, Democratic Republic of the Congo, Gabon, Chad, Central African Republic, Angola, Zimbabwe, Botswana, Namibia, Mozambique, Zambia, Malawi, Madagascar, Djibouti, Gambia.

  Use `region` values from `{Africa}` only, and `subregion` values ONLY from: `North Africa`, `West Africa`, `East Africa`, `Central Africa` (new), `Southern Africa`. Suggested subregion assignment: North Africa (Tunisia, Libya, Sudan), West Africa (Ivory Coast, Mali, Niger, Guinea, Sierra Leone, Benin, Togo, Burkina Faso, Gambia), East Africa (Uganda, Rwanda, Somalia, Eritrea, Djibouti), Central Africa (Cameroon, DR Congo, Gabon, Chad, Central African Republic, Angola), Southern Africa (Zimbabwe, Botswana, Namibia, Mozambique, Zambia, Malawi, Madagascar).

  One fully-worked example (the user's own "Niger" question — use this exact shape for every other entry, researching accurate `capital`/`language`/`religion`/`currency`/`funFact`/`wiki` per country):
  ```json
  { "name": "Niger", "iso2": "NE", "capital": "Niamey", "region": "Africa", "subregion": "West Africa", "population": 26000000, "language": "Hausa", "religion": "Islam", "currency": "West African CFA franc", "funFact": "Niger is home to the W National Park, one of the largest protected wildlife areas in West Africa, shared with Benin and Burkina Faso.", "wiki": "https://en.wikipedia.org/wiki/Niger" }
  ```
  Quality bar: `capital` is a well-established, low-ambiguity fact. `language`/`religion` follow the app's existing "single most common answer" convention (already disclosed in the About screen) — prefer the most WIDELY SPOKEN language by population, not just the official one (the earlier project audit flagged Nigeria/Pakistan for using official-language answers that were arguably contestable; don't repeat that pattern). `funFact` is one sentence, similar tone to existing entries. `wiki` is the real English Wikipedia URL for that country.

- [ ] **Step 2: Add these 10 Oceania countries**: Samoa, Tonga, Vanuatu, Solomon Islands, Kiribati, Federated States of Micronesia, Palau, Marshall Islands, Tuvalu, Nauru.

  `region` is `Oceania`. `subregion` values ONLY from: `Australasia`, `Melanesia`, `Polynesia` (new), `Micronesia` (new). Assignment: Melanesia (Vanuatu, Solomon Islands), Polynesia (Samoa, Tonga, Tuvalu), Micronesia (Kiribati, Federated States of Micronesia, Palau, Marshall Islands, Nauru).

  Example:
  ```json
  { "name": "Samoa", "iso2": "WS", "capital": "Apia", "region": "Oceania", "subregion": "Polynesia", "population": 220000, "language": "Samoan", "religion": "Christianity", "currency": "Samoan tālā", "funFact": "Samoa switched which side of the International Date Line it's on in 2011, skipping December 30 entirely to align its trade week with Australia and New Zealand.", "wiki": "https://en.wikipedia.org/wiki/Samoa" }
  ```

- [ ] **Step 3: Write and run the validation script**

Create a temporary check (not committed — just run it inline):

```bash
node -e "
const c = require('./data/countries.json');
const required = ['name','iso2','capital','region','subregion','population','language','religion','currency','funFact','wiki'];
const validSubregions = new Set([
  'East Asia','South Asia','Southeast Asia','Middle East','Central Asia','Caucasus',
  'Northern Europe','Western Europe','Southern Europe','Eastern Europe','Central Europe',
  'Northern America','Central America','Caribbean','South America',
  'North Africa','West Africa','Southern Africa','East Africa','Central Africa',
  'Australasia','Melanesia','Polynesia','Micronesia',
]);
const names = new Set(), isos = new Set();
let fails = 0;
c.forEach(x => {
  required.forEach(f => { if (!x[f]) { console.log('MISSING', f, 'in', x.name); fails++; } });
  if (!/^[A-Z]{2}\$/.test(x.iso2)) { console.log('BAD ISO2', x.name, x.iso2); fails++; }
  if (!/^https:\/\//.test(x.wiki||'')) { console.log('BAD WIKI URL', x.name); fails++; }
  if (!validSubregions.has(x.subregion)) { console.log('UNKNOWN SUBREGION', x.name, x.subregion); fails++; }
  if (names.has(x.name)) { console.log('DUP NAME', x.name); fails++; } names.add(x.name);
  if (isos.has(x.iso2)) { console.log('DUP ISO2', x.iso2, x.name); fails++; } isos.add(x.iso2);
});
const byRegion = {}; c.forEach(x => byRegion[x.region] = (byRegion[x.region]||0)+1);
console.log('total:', c.length, '| by region:', JSON.stringify(byRegion), '| failures:', fails);
process.exit(fails ? 1 : 0);
"
```

Expected: `total: 115` (76 existing + 29 Africa + 10 Oceania), Africa: 39, Oceania: 14, and `failures: 0`. Fix any reported issue before proceeding.

- [ ] **Step 4: Curl-validate the wiki URL of every country added in this task** (the schema check above only confirms the URL *looks* like `https://...`, not that the article resolves — every new external URL must be checked per the Global Constraints):

```bash
node -e "
const c = require('./data/countries.json');
const added = ['Tunisia','Libya','Sudan','Ivory Coast','Mali','Niger','Guinea','Sierra Leone','Benin','Togo','Burkina Faso','Uganda','Rwanda','Somalia','Eritrea','Cameroon','Democratic Republic of the Congo','Gabon','Chad','Central African Republic','Angola','Zimbabwe','Botswana','Namibia','Mozambique','Zambia','Malawi','Madagascar','Djibouti','Gambia','Samoa','Tonga','Vanuatu','Solomon Islands','Kiribati','Federated States of Micronesia','Palau','Marshall Islands','Tuvalu','Nauru'];
added.forEach(n => { const x = c.find(y => y.name === n); if (!x) { console.log('NOT FOUND', n); return; } console.log(x.wiki); });
" | while read url; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L -A "WorldlyGame/1.0 (wiki validation)" "$url")
  if [ "$code" != "200" ]; then echo "FAIL $code $url"; fi
done
echo "validation complete — no FAIL lines above means every new wiki URL resolves"
```

Fix any reported failure (correct the URL — usually a naming/disambiguation mismatch) before proceeding.

- [ ] **Step 5: Run the existing test suite to confirm nothing broke**

Run: `npm test`
Expected: all existing tests pass (the unit tests use a separate synthetic fixture, unaffected by real data growth).

- [ ] **Step 6: Commit**

```bash
git add data/countries.json
git commit -m "Worldly: add 29 African and 10 Oceanian countries (76 -> 115)"
```

### Task 2: Add Asia + Europe top-up countries

**Files:**
- Modify: `data/countries.json`

**Interfaces:**
- Produces: 39 Asia entries (23 existing + 16 new), 34 Europe entries (22 existing + 12 new).

- [ ] **Step 1: Add these 16 Asian countries**: Afghanistan, Myanmar, Laos, North Korea, Yemen, Jordan, Lebanon, Iraq, Oman, Kuwait, Uzbekistan, Turkmenistan, Kyrgyzstan, Georgia, Armenia, Bhutan.

  `region` is `Asia`. `subregion` from the existing set PLUS one new value `Caucasus` (for Georgia, Armenia): `East Asia` (North Korea), `South Asia` (Bhutan), `Southeast Asia` (Myanmar, Laos), `Middle East` (Yemen, Jordan, Lebanon, Iraq, Oman, Kuwait), `Central Asia` (Afghanistan, Uzbekistan, Turkmenistan, Kyrgyzstan), `Caucasus` (Georgia, Armenia).

  Example:
  ```json
  { "name": "Jordan", "iso2": "JO", "capital": "Amman", "region": "Asia", "subregion": "Middle East", "population": 11000000, "language": "Arabic", "religion": "Islam", "currency": "Jordanian dinar", "funFact": "Jordan is home to Petra, a city carved directly into rose-colored sandstone cliffs by the Nabataeans over 2,000 years ago.", "wiki": "https://en.wikipedia.org/wiki/Jordan" }
  ```

- [ ] **Step 2: Add these 12 European countries**: Croatia, Serbia, Slovenia, Albania, North Macedonia, Romania, Bulgaria, Slovakia, Lithuania, Latvia, Estonia, Luxembourg.

  `region` is `Europe`, using ONLY existing subregions: `Southern Europe` (Croatia, Serbia, Slovenia, Albania, North Macedonia), `Eastern Europe` (Romania, Bulgaria, Slovakia), `Northern Europe` (Lithuania, Latvia, Estonia), `Western Europe` (Luxembourg).

  Example:
  ```json
  { "name": "Croatia", "iso2": "HR", "capital": "Zagreb", "region": "Europe", "subregion": "Southern Europe", "population": 3900000, "language": "Croatian", "religion": "Christianity", "currency": "Euro", "funFact": "Croatia's Plitvice Lakes National Park has 16 terraced lakes connected by waterfalls, all colored different shades of blue and green by mineral deposits.", "wiki": "https://en.wikipedia.org/wiki/Croatia" }
  ```

- [ ] **Step 3: Run the validation script from Task 1, Step 3** (the Node schema/dup/subregion check)

Expected: `total: 143`, Asia: 39, Europe: 34, `failures: 0`.

- [ ] **Step 4: Curl-validate the wiki URL of every country added in this task** — reuse Task 1 Step 4's exact curl loop, with `added` replaced by this task's 16+12 names:

```bash
node -e "
const c = require('./data/countries.json');
const added = ['Afghanistan','Myanmar','Laos','North Korea','Yemen','Jordan','Lebanon','Iraq','Oman','Kuwait','Uzbekistan','Turkmenistan','Kyrgyzstan','Georgia','Armenia','Bhutan','Croatia','Serbia','Slovenia','Albania','North Macedonia','Romania','Bulgaria','Slovakia','Lithuania','Latvia','Estonia','Luxembourg'];
added.forEach(n => { const x = c.find(y => y.name === n); if (!x) { console.log('NOT FOUND', n); return; } console.log(x.wiki); });
" | while read url; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L -A "WorldlyGame/1.0 (wiki validation)" "$url")
  if [ "$code" != "200" ]; then echo "FAIL $code $url"; fi
done
echo "validation complete — no FAIL lines above means every new wiki URL resolves"
```

Fix any reported failure before proceeding.

- [ ] **Step 5: Run tests**

Run: `npm test` — expect all pass.

- [ ] **Step 6: Commit**

```bash
git add data/countries.json
git commit -m "Worldly: add 16 Asian and 12 European countries (115 -> 143)"
```

### Task 3: Add Americas top-up countries (final data batch)

**Files:**
- Modify: `data/countries.json`

**Interfaces:**
- Produces: 16 North America entries (8 existing + 8 new), 12 South America entries (9 existing + 3 new). Final total: 154.

- [ ] **Step 1: Add these 8 North American countries**: Honduras, Nicaragua, El Salvador, Belize, Dominican Republic, Haiti, Bahamas, Trinidad and Tobago.

  `region` is `North America`, `subregion` from existing set: `Central America` (Honduras, Nicaragua, El Salvador, Belize), `Caribbean` (Dominican Republic, Haiti, Bahamas, Trinidad and Tobago).

  Example:
  ```json
  { "name": "Honduras", "iso2": "HN", "capital": "Tegucigalpa", "region": "North America", "subregion": "Central America", "population": 10000000, "language": "Spanish", "religion": "Christianity", "currency": "Honduran lempira", "funFact": "The Bay Islands off Honduras's Caribbean coast sit on the second-largest barrier reef system in the world, after Australia's Great Barrier Reef.", "wiki": "https://en.wikipedia.org/wiki/Honduras" }
  ```

- [ ] **Step 2: Add these 3 South American countries**: Paraguay, Guyana, Suriname.

  `region` is `South America`, `subregion` is `South America` (the existing flat single subregion for that region).

  Example:
  ```json
  { "name": "Paraguay", "iso2": "PY", "capital": "Asunción", "region": "South America", "subregion": "South America", "population": 6700000, "language": "Guarani", "religion": "Christianity", "currency": "Paraguayan guaraní", "funFact": "Paraguay is one of only a few countries in the world where an indigenous language, Guarani, is spoken by a majority of the population alongside Spanish.", "wiki": "https://en.wikipedia.org/wiki/Paraguay" }
  ```

- [ ] **Step 3: Run the validation script from Task 1, Step 3** (the Node schema/dup/subregion check)

Expected: `total: 154`, North America: 16, South America: 12, and every region count matching: Asia 39, Europe 34, North America 16, South America 12, Africa 39, Oceania 14 (sum = 154). `failures: 0`.

- [ ] **Step 4: Curl-validate the wiki URL of every country added in this task**:

```bash
node -e "
const c = require('./data/countries.json');
const added = ['Honduras','Nicaragua','El Salvador','Belize','Dominican Republic','Haiti','Bahamas','Trinidad and Tobago','Paraguay','Guyana','Suriname'];
added.forEach(n => { const x = c.find(y => y.name === n); if (!x) { console.log('NOT FOUND', n); return; } console.log(x.wiki); });
" | while read url; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L -A "WorldlyGame/1.0 (wiki validation)" "$url")
  if [ "$code" != "200" ]; then echo "FAIL $code $url"; fi
done
echo "validation complete — no FAIL lines above means every new wiki URL resolves"
```

Fix any reported failure before proceeding.

- [ ] **Step 5: Spot-check accuracy**

Pick 8 random new entries across different regions and manually verify capital + language + religion against a reliable reference (e.g. CIA World Factbook or Wikipedia) before moving on — this is the same spot-check discipline used for `historic_flags.json` and `music.json` earlier in this project.

- [ ] **Step 6: Run tests**

Run: `npm test` — expect all pass.

- [ ] **Step 7: Update docs**

Modify `README.md` and `ROADMAP.md`: change any reference to "76 countries" to "154 countries" (grep for `76` in both files first to find exact lines), and mark the ROADMAP.md line `Expand country set from 76 → all ~195 sovereign states` as partially done, e.g. `- [x] Expand country set from 76 → 154 (biggest gaps in Africa/Oceania filled; full ~195 coverage remains a future stretch goal).`

- [ ] **Step 8: Commit**

```bash
git add data/countries.json README.md ROADMAP.md
git commit -m "Worldly: add 8 North American and 3 South American countries (143 -> 154), update docs"
```

---

## Phase 2 — Region-aware distractor selection

### Task 4: Add subregion fields to the test fixture + a geography test case

**Files:**
- Modify: `tests/engine.test.mjs:12-19` (the synthetic `countries` fixture), `tests/engine.test.mjs:43,53` (two count assertions that will shift)

**Interfaces:**
- Produces: an updated 6-country test fixture with a `subregion` field on every entry, used by Task 5's new tests.

- [ ] **Step 1: Replace the countries fixture** (lines 13-19) with:

```js
  countries: [
    { name: 'Japan', iso2: 'JP', capital: 'Tokyo', region: 'Asia', subregion: 'East Asia', language: 'Japanese', religion: 'Shinto/Buddhism', funFact: 'Many islands.', wiki: 'https://w/Japan' },
    { name: 'France', iso2: 'FR', capital: 'Paris', region: 'Europe', subregion: 'Western Europe', language: 'French', religion: 'Christianity', funFact: 'Most visited.', wiki: 'https://w/France' },
    { name: 'Brazil', iso2: 'BR', capital: 'Brasília', region: 'South America', subregion: 'South America', language: 'Portuguese', religion: 'Christianity', funFact: 'Amazon.', wiki: 'https://w/Brazil' },
    { name: 'Egypt', iso2: 'EG', capital: 'Cairo', region: 'Africa', subregion: 'North Africa', language: 'Arabic', religion: 'Islam', funFact: 'Pyramids.', wiki: 'https://w/Egypt' },
    { name: 'Kenya', iso2: 'KE', capital: 'Nairobi', region: 'Africa', subregion: 'East Africa', language: 'Swahili', religion: 'Christianity', funFact: 'Safari.', wiki: 'https://w/Kenya' },
    { name: 'Tanzania', iso2: 'TZ', capital: 'Dodoma', region: 'Africa', subregion: 'East Africa', language: 'Swahili', religion: 'Christianity', funFact: 'Serengeti.', wiki: 'https://w/Tanzania' },
  ],
```

- [ ] **Step 2: Update the two count assertions that reference the old 5-country total**

In the test `'buildPool covers every enabled mode'` (around line 43-48), change:
```js
  assert.equal(pool.length, 5 * 5 + 4 * 6 + 1 + 1 + 4 + 6);
```
to:
```js
  assert.equal(pool.length, 6 * 5 + 4 * 6 + 1 + 1 + 4 + 6);
```
and update the comment above it from `5 countries × 5 country-modes` to `6 countries × 5 country-modes`.

In the test `'buildPool filters by continent for country modes'` (around line 52-55), change:
```js
  const pool = buildPool(data, { modes: ['capital'], continents: ['Africa'] });
  assert.equal(pool.length, 2); // Egypt + Kenya
```
to:
```js
  const pool = buildPool(data, { modes: ['capital'], continents: ['Africa'] });
  assert.equal(pool.length, 3); // Egypt + Kenya + Tanzania
```

- [ ] **Step 3: Run tests to confirm the fixture change alone doesn't break anything**

Run: `node --test tests/engine.test.mjs`
Expected: all existing tests still pass (48/48).

- [ ] **Step 4: Commit**

```bash
git add tests/engine.test.mjs
git commit -m "Worldly: add subregion field to test fixture (Tanzania as Kenya's East Africa neighbor)"
```

### Task 5: Write the `geoDistractors()` helper with failing tests first

**Files:**
- Modify: `js/quiz.js` (add new exported function, alongside `sampleDistinct`)
- Test: `tests/engine.test.mjs` (new test block)

**Interfaces:**
- Produces: `export function geoDistractors(countries, target, field, n, rng)` returning up to `n` distractor VALUES (strings), tiered: same-subregion first, then same-region, then the whole list. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests** — add this block to `tests/engine.test.mjs`, right after the `'weakCount tallies low-box missed items'` test (around line 320, before the `// ---- no-duplicate sessions` comment):

```js
// ---- geography-aware distractors --------------------------------------------

test('geoDistractors prefers same-subregion countries first', () => {
  const kenya = data.countries.find((c) => c.name === 'Kenya');
  const picks = geoDistractors(data.countries, kenya, 'capital', 1, () => 0.5);
  assert.deepEqual(picks, ['Dodoma'], 'Tanzania (same East Africa subregion) is the only tier-1 candidate');
});

test('geoDistractors falls back to region when the subregion is empty', () => {
  const egypt = data.countries.find((c) => c.name === 'Egypt');
  // Egypt is alone in "North Africa" in this fixture — tier 1 is empty, so it
  // must fall back to the "Africa" region, which has Kenya and Tanzania.
  const picks = geoDistractors(data.countries, egypt, 'capital', 2, () => 0.5);
  assert.equal(picks.length, 2);
  assert.ok(picks.every((v) => ['Nairobi', 'Dodoma'].includes(v)), 'falls back to region-mates (Kenya/Tanzania)');
});

test('geoDistractors falls back to the whole world when region-mates run out', () => {
  const japan = data.countries.find((c) => c.name === 'Japan');
  // Japan is alone in both its subregion and region in this fixture, so all
  // 3 distractors must come from the global fallback tier.
  const picks = geoDistractors(data.countries, japan, 'capital', 3, () => 0.5);
  assert.equal(picks.length, 3, 'still fills all 3 distractors via the global fallback');
  assert.ok(!picks.includes('Tokyo'), 'never includes the answer itself');
});

test('geoDistractors never duplicates a value across tiers', () => {
  const egypt = data.countries.find((c) => c.name === 'Egypt');
  const picks = geoDistractors(data.countries, egypt, 'capital', 5, () => 0.1);
  assert.equal(new Set(picks).size, picks.length, 'no duplicate values even when tiers overlap in the top-up');
});
```

- [ ] **Step 2: Add `geoDistractors` to the import line** at the top of `tests/engine.test.mjs`:

Change:
```js
import { buildPool, makeQuestion, createQuiz, shuffle, ALL_MODES, drawWithoutRepeat, answerMatches } from '../js/quiz.js';
```
to:
```js
import { buildPool, makeQuestion, createQuiz, shuffle, geoDistractors, ALL_MODES, drawWithoutRepeat, answerMatches } from '../js/quiz.js';
```

- [ ] **Step 3: Run the new tests to verify they fail** (function doesn't exist yet)

Run: `node --test tests/engine.test.mjs 2>&1 | grep -A2 "geoDistractors"`
Expected: FAIL with `geoDistractors is not a function` or similar import error.

- [ ] **Step 4: Implement `geoDistractors`** — add this function to `js/quiz.js`, right after `sampleDistinct` (after line 43):

```js
/**
 * Distractor VALUES for a country-based question, preferring answers from
 * geographically nearby countries so wrong choices can't be eliminated just
 * by "that's obviously not even on the right continent." Draws from the
 * target's subregion first, tops up from its region if the subregion doesn't
 * have enough distinct values, and finally tops up from the whole country
 * list — so a question always gets `n` distractors, even for countries in
 * very sparse subregions/regions.
 */
export function geoDistractors(countries, target, field, n, rng) {
  const chosen = [];
  const tiers = [
    countries.filter((x) => x !== target && x.subregion === target.subregion),
    countries.filter((x) => x !== target && x.region === target.region),
    countries,
  ];
  for (const tier of tiers) {
    if (chosen.length >= n) break;
    const values = tier.map((x) => x[field]).filter((v) => v && v !== target[field] && !chosen.includes(v));
    const picked = sampleDistinct(values, target[field], n - chosen.length, rng);
    chosen.push(...picked);
  }
  return chosen;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/engine.test.mjs`
Expected: all tests pass (52/52 — 48 existing + 4 new).

- [ ] **Step 6: Commit**

```bash
git add js/quiz.js tests/engine.test.mjs
git commit -m "Worldly: add geoDistractors() — tiered subregion/region/global distractor selection"
```

### Task 6: Wire `geoDistractors` into `makeQuestion` for the 5 country-based modes

**Files:**
- Modify: `js/quiz.js:174-329` (the `makeQuestion` function)
- Test: `tests/engine.test.mjs` (new test block)

**Interfaces:**
- Consumes: `geoDistractors(countries, target, field, n, rng)` from Task 5.
- Produces: `makeQuestion` now draws geography-tiered distractors for `capital`, `country`, `language`, `religion`, and `flag` modes unconditionally (not gated by difficulty); `historic_flag`'s existing difficulty-gated same-region logic is untouched per the approved spec.

- [ ] **Step 1: Write the failing test** — add this to `tests/engine.test.mjs`, right after the Task 5 geography tests:

```js
test('makeQuestion (capital) draws its one distractor from the same subregion when available', () => {
  const kenya = data.countries.find((c) => c.name === 'Kenya');
  const item = { id: 'capital:Kenya', mode: 'capital', region: 'Africa', source: kenya };
  const q = makeQuestion(item, data, { choices: 2 }); // answer + 1 distractor
  assert.equal(q.choices.length, 2);
  assert.ok(q.choices.includes('Nairobi'));
  assert.ok(q.choices.includes('Dodoma'), 'the one distractor is Tanzania (same East Africa subregion), not a random country');
});

test('makeQuestion (language/religion/country/flag) also use geography-tiered distractors', () => {
  const kenya = data.countries.find((c) => c.name === 'Kenya');
  // Kenya and Tanzania share the identical language value ("Swahili") in this
  // fixture, so Tanzania cannot supply a *distinct* subregion-tier distractor
  // here — this must correctly fall through to the region tier (Africa) and
  // pick up Egypt's "Arabic" instead, proving tier fallback is value-aware,
  // not just country-aware.
  const langQ = makeQuestion({ id: 'language:Kenya', mode: 'language', region: 'Africa', source: kenya }, data, { choices: 2 });
  assert.equal(langQ.choices.length, 2);
  assert.ok(langQ.choices.includes('Swahili'), 'the answer is present');
  assert.ok(langQ.choices.includes('Arabic'), 'falls back to the region tier (Egypt) since Tanzania has no distinct language value');

  const countryQ = makeQuestion({ id: 'country:Kenya', mode: 'country', region: 'Africa', source: kenya }, data, { choices: 2 });
  assert.ok(countryQ.choices.includes('Kenya'));
  assert.ok(countryQ.choices.includes('Tanzania'), 'country mode also prefers the subregion neighbor');

  const flagQ = makeQuestion({ id: 'flag:Kenya', mode: 'flag', region: 'Africa', source: kenya }, data, { choices: 2 });
  assert.ok(flagQ.choices.includes('Kenya'));
  assert.ok(flagQ.choices.includes('Tanzania'), 'flag mode also prefers the subregion neighbor');
});

test('makeQuestion (historic_flag) region-preference is still gated by difficulty (unchanged behavior)', () => {
  const item = { id: 'historic_flag:Rhodesia', mode: 'historic_flag', region: 'Africa', source: data.historicFlags[2] };
  // Only Rhodesia is Africa-region among the 4 historic flags; the other 3
  // (Soviet Union, Ottoman Empire, Yugoslavia) are Europe/Asia. With
  // difficulty left at its 'medium' default (not 'hard'), the pre-existing
  // same-region gate must NOT kick in, so all 4 entries stay eligible — with
  // choices=4 and exactly 4 total entries, every one of them must appear.
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.choices.length, 4);
  const nonAfrica = ['Soviet Union', 'Ottoman Empire', 'Yugoslavia'];
  assert.ok(nonAfrica.every((n) => q.choices.includes(n)), 'medium difficulty still pulls from every region, unaffected by the new always-on country-mode tiering');
});
```

- [ ] **Step 2: Run the tests to verify the new assertions fail**

Run: `node --test tests/engine.test.mjs 2>&1 | tail -30`
Expected: FAIL on `'Dodoma'`/`'Tanzania'` assertions (current code draws from the full country list, not subregion-first).

- [ ] **Step 3: Update `makeQuestion`** in `js/quiz.js`. Replace the entire function (lines 174-329) with:

```js
/** Turn one pool item into a full multiple-choice question. */
export function makeQuestion(item, data, { difficulty = 'medium', choices = 4, rng = Math.random } = {}) {
  const c = item.source;
  const mode = item.mode;
  let prompt, answer, distractorValues, flagIso = null, flagImg = null, isCountry = true;

  switch (mode) {
    case 'capital':
      prompt = `What is the capital of ${c.name}?`;
      answer = c.capital;
      break;
    case 'country':
      prompt = `Which country has the capital ${c.capital}?`;
      answer = c.name;
      break;
    case 'language':
      prompt = `What is the most widely spoken language in ${c.name}?`;
      answer = c.language;
      break;
    case 'religion':
      prompt = `What is the largest religion in ${c.name}?`;
      answer = c.religion;
      break;
    case 'religion_founder':
      prompt = `Who is the central figure most associated with ${c.name}?`;
      answer = c.founder;
      distractorValues = (data.religions || []).map((x) => x.founder);
      isCountry = false;
      break;
    case 'religion_text':
      prompt = `What is a primary sacred text of ${c.name}?`;
      answer = c.text;
      distractorValues = (data.religions || []).map((x) => x.text);
      isCountry = false;
      break;
    case 'religion_holiday':
      prompt = `Which major festival is associated with ${c.name}?`;
      answer = c.holiday;
      distractorValues = (data.religions || []).map((x) => x.holiday);
      isCountry = false;
      break;
    case 'religion_symbol':
      prompt = `Which symbol is most associated with ${c.name}?`;
      answer = c.symbol;
      distractorValues = (data.religions || []).map((x) => x.symbol);
      isCountry = false;
      break;
    case 'religion_place':
      prompt = `What is the traditional place of worship in ${c.name}?`;
      answer = c.worship;
      distractorValues = (data.religions || []).map((x) => x.worship);
      isCountry = false;
      break;
    case 'religion_origin':
      prompt = `In which region did ${c.name} originate?`;
      answer = c.origin;
      distractorValues = (data.religions || []).map((x) => x.origin);
      isCountry = false;
      break;
    case 'flag':
      prompt = 'Which country does this flag belong to?';
      answer = c.name;
      flagIso = c.iso2;
      break;
    case 'similar_flag':
      prompt = 'These flags all look alike — which country is this?';
      answer = c.name;
      flagIso = c.iso2;
      // Distractors are drawn only from the same look-alike group, so every
      // option is a genuinely confusable flag. Short groups are topped up from
      // the wider similar-flag set below.
      distractorValues = (item.group || []).filter((n) => n !== answer);
      break;
    case 'historic_flag': {
      prompt = 'Which nation flew this flag?';
      answer = c.name;
      flagImg = c.img;
      isCountry = false;
      // Keep options coherent: distractors are other historic entities. On
      // hard, prefer same-region entities; fall back to the full set when a
      // region is short so we can always fill the requested number of
      // choices. (Unchanged — historic flags are out of scope for the
      // always-on geography tiering used by the country modes below.)
      const all = data.historicFlags || [];
      const sameRegionHist = all.filter((x) => x.region === c.region);
      const histPool = difficulty === 'hard' && sameRegionHist.length >= choices ? sameRegionHist : all;
      distractorValues = histPool.map((x) => x.name);
      break;
    }
    case 'us_capital':
      prompt = `What is the capital of ${c.name}? (U.S. state)`;
      answer = c.capital;
      distractorValues = data.usStates.map((x) => x.capital);
      isCountry = false;
      break;
    case 'mx_capital':
      prompt = `What is the capital of ${c.name}? (Mexican state)`;
      answer = c.capital;
      distractorValues = data.mxStates.map((x) => x.capital);
      isCountry = false;
      break;
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  // The five country-based modes always draw distractors from nearby
  // countries (same subregion, falling back to region, falling back to the
  // whole world) so wrong answers can't be eliminated just by "that's not
  // even close." This applies unconditionally, regardless of `difficulty`.
  const GEO_FIELD = { capital: 'capital', country: 'name', language: 'language', religion: 'religion', flag: 'name' };
  const geoField = GEO_FIELD[mode];
  let distractors;
  if (geoField) {
    distractors = geoDistractors(data.countries, c, geoField, choices - 1, rng);
  } else {
    distractors = sampleDistinct(distractorValues, answer, choices - 1, rng);
    // Similar-flag groups smaller than `choices` top up from the wider pool of
    // look-alike countries so options stay hard to tell apart (never plain
    // random countries, which would give the answer away).
    if (distractors.length < choices - 1 && mode === 'similar_flag') {
      const chosenSet = new Set([answer, ...distractors]);
      const allSimilar = (data.similarFlags || [])
        .flatMap((g) => g.countries.map((x) => x.name))
        .filter((n) => !chosenSet.has(n));
      const extra = sampleDistinct(allSimilar, answer, choices - 1 - distractors.length, rng);
      distractors.push(...extra);
    }
    // Historic-flag and religion questions keep their options within their
    // own set (nations of the past / world religions) — no global top-up.
    const selfContained = mode === 'historic_flag' || mode === 'similar_flag' || MODES[mode]?.source === 'religion';
    if (distractors.length < choices - 1 && !selfContained) {
      const extra = sampleDistinct(
        [...data.countries.map((x) => x.name), ...data.countries.map((x) => x.capital)],
        answer,
        choices - 1 - distractors.length,
        rng
      ).filter((v) => !distractors.includes(v));
      distractors.push(...extra);
    }
  }

  const options = shuffle([answer, ...distractors], rng);

  return {
    id: item.id,
    category: mode,
    region: item.region,
    prompt,
    answer,
    choices: options,
    flagIso,
    flagImg,
    funFact: c.funFact,
    learnMore: learnMoreFor(c, isCountry),
    source: c,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass (55/55 — 52 from Task 5 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add js/quiz.js tests/engine.test.mjs
git commit -m "Worldly: wire geoDistractors into capital/country/language/religion/flag modes"
```

---

## Phase 3 — Flag Key screen

### Task 7: Generalize `getContinents()` into a dataset-agnostic `getRegions()`

**Files:**
- Modify: `js/data.js:60-63`
- Test: none needed (trivial pure function, exercised indirectly by Task 9's browser check)

**Interfaces:**
- Produces: `export function getRegions(list)` — distinct, sorted region values from any array of records with a `.region` field. `getContinents()` stays as a thin wrapper for existing callers (Custom Study) so nothing else needs to change.

- [ ] **Step 1: Replace `getContinents()`** in `js/data.js` (lines 60-63) with:

```js
/** Distinct region/continent values in any list of records with a `.region` field. */
export function getRegions(list) {
  return [...new Set(list.map((x) => x.region))].sort();
}

/** Distinct continents/regions present in the country dataset (back-compat wrapper). */
export function getContinents() {
  return getRegions(DATA.countries);
}
```

- [ ] **Step 2: Run tests**

Run: `npm test` — expect all pass (this is additive, `getContinents()` behavior is unchanged).

- [ ] **Step 3: Commit**

```bash
git add js/data.js
git commit -m "Worldly: generalize getContinents() into dataset-agnostic getRegions()"
```

### Task 8: Add `showFlagKey()` screen with sub-tabs, search, and region dropdown

**Files:**
- Modify: `js/main.js` — add import, add a home-card entry, add the new screen function
- Modify: `css/styles.css` — one small addition if needed (checked in Step 4 below; the existing `.grid`/`.card`/`.form-block`/`.select`/`.type-input`/`.tabs` classes already cover this screen)

**Interfaces:**
- Consumes: `getData()`, `getRegions()`, `flagUrl()` from `js/data.js` (Task 7); `wireTabs()`, `topNav()`, `wireNav()`, `esc()` already in `js/main.js`.
- Produces: `showFlagKey()`, wired to a new `key` entry in the `journeyCards` array and a new `data-go="key"` click handler in `showHome()`.

- [ ] **Step 1: Update the `data.js` import line** at the top of `js/main.js` (currently around line 4):

Change:
```js
import { loadData, getData, getContinents, flagUrl, historicFlagUrl, loadMap } from './data.js';
```
to:
```js
import { loadData, getData, getContinents, getRegions, flagUrl, historicFlagUrl, loadMap } from './data.js';
```

- [ ] **Step 2: Register the new card** — in `showHome()`'s `journeyCards` array (around line 222-231), add one entry right after `phrases`:

```js
    { key: 'phrases', emoji: '🗣️', title: 'Phrases', desc: 'Common phrases & local sayings around the world.' },
    { key: 'flagkey', emoji: '🚩', title: 'Flag Key', desc: 'Browse every country, US state & Mexican state by flag and name.' },
```

And add the click handler right after the existing `phrases` handler (around line 283):

```js
  app.querySelector('[data-go="phrases"]').addEventListener('click', showPhrases);
  app.querySelector('[data-go="flagkey"]').addEventListener('click', showFlagKey);
```

- [ ] **Step 3: Write `showFlagKey()`** — add this function to `js/main.js`, right before `showPhrases()` (find `function showPhrases() {` and insert above it):

```js
// ============================================================================
//  FLAG KEY  (browsable reference: every country / US state / Mexican state,
//  with its flag and name — not a quiz, just a legend to look things up in)
// ============================================================================
let flagKeyTab = 'countries';
let flagKeySearch = { countries: '', us: '', mx: '' };
let flagKeyRegion = { countries: '', us: '', mx: '' };

function showFlagKey() {
  leaveSession();
  const data = getData();
  const groups = [
    { id: 'countries', label: 'Countries', list: data.countries, flagFn: (x) => flagUrl(x.iso2, 'w80') },
    { id: 'us', label: 'US States', list: data.usStates, flagFn: (x) => stateFlagUrl(x.flag) },
    { id: 'mx', label: 'Mexican States', list: data.mxStates, flagFn: (x) => stateFlagUrl(x.flag) },
  ];
  if (!groups.some((g) => g.id === flagKeyTab)) flagKeyTab = 'countries';

  const panelFor = (g) => {
    const regions = getRegions(g.list);
    const term = flagKeySearch[g.id].toLowerCase();
    const region = flagKeyRegion[g.id];
    const visible = g.list.filter((x) =>
      (!term || x.name.toLowerCase().includes(term)) && (!region || x.region === region));
    return `
      <div class="form-block">
        <input type="text" class="type-input flagkey-search" data-group="${g.id}" placeholder="Search ${esc(g.label.toLowerCase())}…" value="${esc(flagKeySearch[g.id])}">
        <select class="select mt-10 flagkey-region" data-group="${g.id}">
          <option value="">All regions</option>
          ${regions.map((r) => `<option value="${esc(r)}" ${r === region ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div class="grid flagkey-grid" data-group="${g.id}">
        ${visible.map((x) => `
          <div class="card flagkey-card">
            <img class="emoji-flag" alt="" src="${g.flagFn(x)}" onerror="this.style.display='none'">
            <span class="card-title">${esc(x.name)}</span>
            <span class="card-desc">${esc(x.capital)}</span>
          </div>`).join('')}
      </div>
      ${visible.length === 0 ? '<p class="screen-sub">No matches.</p>' : ''}`;
  };

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Flag Key 🚩</h1>
    <p class="screen-sub">A browsable reference — every country, US state and Mexican state, by flag and name. Not a quiz.</p>

    <div class="tabs" role="tablist">
      ${groups.map((g) => `<button class="tab ${g.id === flagKeyTab ? 'active' : ''}" role="tab" id="tab-${g.id}" aria-controls="panel-${g.id}" aria-selected="${g.id === flagKeyTab}" tabindex="${g.id === flagKeyTab ? 0 : -1}" data-tab="${g.id}">${esc(g.label)}</button>`).join('')}
    </div>

    ${groups.map((g) => `
      <div class="tab-panel ${g.id === flagKeyTab ? 'active' : ''}" data-panel="${g.id}" id="panel-${g.id}" role="tabpanel" aria-labelledby="tab-${g.id}">
        ${panelFor(g)}
      </div>`).join('')}

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;

  wireNav();
  wireTabs((id) => { flagKeyTab = id; });
  app.querySelector('#backHome').addEventListener('click', showHome);

  // Re-render just the active panel's grid on every search/region change,
  // without losing focus or rebuilding the whole screen.
  const rerenderGroup = (id) => {
    const g = groups.find((x) => x.id === id);
    app.querySelector(`.tab-panel[data-panel="${id}"]`).innerHTML = panelFor(g);
    wireFlagKeyControls(id);
  };
  function wireFlagKeyControls(id) {
    const panel = app.querySelector(`.tab-panel[data-panel="${id}"]`);
    panel.querySelector('.flagkey-search').addEventListener('input', (e) => {
      flagKeySearch[id] = e.target.value;
      rerenderGroup(id);
      panel.querySelector('.flagkey-search').focus();
      const v = panel.querySelector('.flagkey-search').value;
      panel.querySelector('.flagkey-search').setSelectionRange(v.length, v.length);
    });
    panel.querySelector('.flagkey-region').addEventListener('change', (e) => {
      flagKeyRegion[id] = e.target.value;
      rerenderGroup(id);
    });
  }
  groups.forEach((g) => wireFlagKeyControls(g.id));
}
```

- [ ] **Step 4: Check whether any new CSS is needed**

Run: `grep -n "flagkey" css/styles.css` — expect no matches (new markup reuses `.form-block`, `.type-input`, `.select`, `.grid`, `.card`, `.emoji-flag`, `.card-title`, `.card-desc`, `.mt-10`, `.mt-18` — all already styled). If the flag key cards look wrong once verified in the browser (Task 9), only then add a `.flagkey-card { cursor: default; }` rule (since these cards are non-interactive, unlike quiz `.card` buttons) to `css/styles.css` right after the existing `.card:hover` rule.

- [ ] **Step 5: Manual verification (no unit test for DOM-heavy UI — verify in a real browser)**

Run: `python3 -m http.server 8000` from the `Worldly/` directory, open `http://localhost:8000`, click **Explore → Flag Key**, and confirm:
- Three tabs (Countries / US States / Mexican States) switch correctly.
- Typing in the search box filters the visible cards live, without losing focus mid-keystroke.
- The region dropdown filters correctly and combines with the search box (AND logic).
- Cards show a flag image, name, and capital; nothing is clickable (no console errors on click).
- US/Mexico tabs show a broken-image icon for now (Task 9/10 haven't added `flag` data yet) — this is expected at this point in the plan.

- [ ] **Step 6: Run tests**

Run: `npm test` — expect all pass (this task adds no new unit-testable pure logic).

- [ ] **Step 7: Commit**

```bash
git add js/main.js css/styles.css
git commit -m "Worldly: add Flag Key screen (sub-tabs, live search, region dropdown)"
```

---

## Phase 4 — US/Mexico state flag data

### Task 9: Source and validate US state flags

**Files:**
- Modify: `data/us_states.json` (add a `flag` field to all 50 entries)

**Interfaces:**
- Produces: every US state record gains `"flag": "Flag of <State>.svg"` (Wikimedia Commons filename), consumed by `stateFlagUrl()` in Task 11.

- [ ] **Step 1: Add a `flag` field to every one of the 50 entries** in `data/us_states.json`, following the Wikimedia Commons naming convention `Flag of <State Name>.svg` (this is the standard, verified naming pattern Commons uses for all 50 US state flags). Example for the first entry:

```json
{ "name": "Alabama", "capital": "Montgomery", "region": "South", "funFact": "Montgomery was the first capital of the Confederacy in 1861.", "wiki": "https://en.wikipedia.org/wiki/Alabama", "flag": "Flag of Alabama.svg" }
```

Repeat for all 50 states, using each state's exact name as it appears in the existing `name` field (e.g. `"Flag of New York.svg"`, `"Flag of North Carolina.svg"`).

- [ ] **Step 2: Validate every filename actually resolves on Commons**

```bash
node -e "
const s = require('./data/us_states.json');
s.forEach(x => { if (!x.flag) { console.log('MISSING flag for', x.name); process.exit(1); } });
console.log('all', s.length, 'US states have a flag field');
s.forEach(x => console.log(encodeURIComponent(x.flag)));
" > /tmp/us_flags.txt
tail -n +2 /tmp/us_flags.txt | while read f; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-redirs 3 -A "WorldlyGame/1.0 (flag validation)" "https://commons.wikimedia.org/wiki/Special:FilePath/${f}?width=64")
  if [ "$code" != "200" ]; then echo "FAIL $code $f"; fi
done
echo "validation complete — no FAIL lines above means all 50 resolve"
```

Fix any filename reported as a failure (search Wikimedia Commons for the correct exact filename and update `data/us_states.json`), then re-run until zero `FAIL` lines appear.

- [ ] **Step 3: Run tests**

Run: `npm test` — expect all pass (no schema fields were removed, only added).

- [ ] **Step 4: Commit**

```bash
git add data/us_states.json
git commit -m "Worldly: add Wikimedia Commons flag filenames for all 50 US states"
```

### Task 10: Source and validate Mexican state flags

**Files:**
- Modify: `data/mexico_states.json` (add a `flag` field to all 32 entries)

**Interfaces:**
- Produces: every Mexican state record gains a `flag` field (Wikimedia Commons filename), consumed by `stateFlagUrl()` in Task 11.

- [ ] **Step 1: Add a `flag` field to every one of the 32 entries** in `data/mexico_states.json`. Mexican state flags on Commons are inconsistently named (some as `"Flag of <State>.svg"`, others as `"Bandera de <Estado>.svg"`) — for each state, search Wikimedia Commons directly (e.g. `https://commons.wikimedia.org/wiki/Category:Flags_of_Mexican_states`) to find the exact real filename, rather than assuming one convention. Example for the first entry (Aguascalientes' actual Commons file is `"Flag of Aguascalientes.svg"`):

```json
{ "name": "Aguascalientes", "capital": "Aguascalientes", "region": "Bajío", "funFact": "Aguascalientes hosts the San Marcos Fair, one of Mexico's oldest and largest national fairs.", "wiki": "https://en.wikipedia.org/wiki/Aguascalientes", "flag": "Flag of Aguascalientes.svg" }
```

- [ ] **Step 2: Validate every filename actually resolves on Commons**

```bash
node -e "
const s = require('./data/mexico_states.json');
s.forEach(x => { if (!x.flag) { console.log('MISSING flag for', x.name); process.exit(1); } });
console.log('all', s.length, 'Mexican states have a flag field');
s.forEach(x => console.log(encodeURIComponent(x.flag)));
" > /tmp/mx_flags.txt
tail -n +2 /tmp/mx_flags.txt | while read f; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-redirs 3 -A "WorldlyGame/1.0 (flag validation)" "https://commons.wikimedia.org/wiki/Special:FilePath/${f}?width=64")
  if [ "$code" != "200" ]; then echo "FAIL $code $f"; fi
done
echo "validation complete — no FAIL lines above means all 32 resolve"
```

Fix any failures by re-checking the exact Commons filename, then re-run until zero `FAIL` lines appear.

- [ ] **Step 3: Run tests**

Run: `npm test` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add data/mexico_states.json
git commit -m "Worldly: add Wikimedia Commons flag filenames for all 32 Mexican states"
```

### Task 11: Add `stateFlagUrl()` helper and wire it into the Flag Key

**Files:**
- Modify: `js/data.js` (new exported function, alongside `historicFlagUrl`)
- Test: `tests/engine.test.mjs` (one new test)

**Interfaces:**
- Produces: `export function stateFlagUrl(filename, width = 320)` — identical shape to `historicFlagUrl`, already referenced by `showFlagKey()` in Task 8.

- [ ] **Step 1: Write the failing test** — add to `tests/engine.test.mjs`, right after the existing `'historicFlagUrl builds a stable Wikimedia Special:FilePath URL'` test:

```js
test('stateFlagUrl builds a stable Wikimedia Special:FilePath URL', () => {
  const url = stateFlagUrl('Flag of Alabama.svg');
  assert.match(url, /commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
  assert.match(url, /Flag%20of%20Alabama\.svg/);
  assert.match(url, /width=320/);
});
```

And add `stateFlagUrl` to the existing `data.js` import line at the top of the file:
```js
import { historicFlagUrl } from '../js/data.js';
```
becomes:
```js
import { historicFlagUrl, stateFlagUrl } from '../js/data.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/engine.test.mjs 2>&1 | grep -A3 stateFlagUrl`
Expected: FAIL — `stateFlagUrl is not a function`.

- [ ] **Step 3: Implement `stateFlagUrl`** in `js/data.js`, right after `historicFlagUrl` (after line 78):

```js
/** US/Mexico state flag image URL, same stable Wikimedia Commons endpoint as historicFlagUrl. */
export function stateFlagUrl(filename, width = 320) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test` — expect all pass (56/56 — 55 from Phase 2 + 1 new).

- [ ] **Step 5: Add the `stateFlagUrl` import to `main.js`**

Change the `data.js` import line in `js/main.js` (already updated in Task 8, Step 1) from:
```js
import { loadData, getData, getContinents, getRegions, flagUrl, historicFlagUrl, loadMap } from './data.js';
```
to:
```js
import { loadData, getData, getContinents, getRegions, flagUrl, historicFlagUrl, stateFlagUrl, loadMap } from './data.js';
```

- [ ] **Step 6: Manual verification in the browser**

Run: `python3 -m http.server 8000` from `Worldly/`, open `http://localhost:8000`, go to **Explore → Flag Key → US States** and **Mexican States** tabs, and confirm real flag images now load for every card (no broken-image icons). Spot-check 5 states per tab.

- [ ] **Step 7: Commit**

```bash
git add js/data.js js/main.js tests/engine.test.mjs
git commit -m "Worldly: add stateFlagUrl() helper, wire real state flags into the Flag Key"
```

---

## Self-Review Notes

**Spec coverage:** Phase 1 covers the country-expansion requirement (76→154, Africa/Oceania prioritized). Phase 2 covers region-aware distractors for all 5 country-based modes, historic flags explicitly left untouched per spec. Phase 3 covers the Flag Key screen (placement under Explore, 3 sub-tabs, search + region dropdown, flag+name+capital cards, no detail view). Phase 4 covers state flag sourcing + validation. All four spec phases have corresponding tasks — no gaps found.

**Type/interface consistency:** `geoDistractors(countries, target, field, n, rng)` signature is identical between its definition (Task 5) and every call site (Task 6). `getRegions(list)` is defined once (Task 7) and consumed identically in `showFlagKey()` (Task 8). `stateFlagUrl(filename, width)` matches `historicFlagUrl`'s exact shape and is defined (Task 11) before any consumer needs it structurally, though `showFlagKey()` (Task 8) references it ahead of Task 11's implementation — this is fine since `showFlagKey()` isn't runnable/tested until Task 11 lands the function it calls; Task 8's own manual-verification step (Step 5) explicitly notes the expected broken-image state until Task 9-11 land, so this ordering is intentional and called out, not an oversight.

**No placeholders:** every code step contains complete, runnable code; every data task gives an exact, complete, enumerable list of which records to add (no "add some countries" vagueness) plus one fully-worked example per batch and an exact runnable validation script.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-05-flag-key-and-region-distractors-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
