// Engine tests — run with `npm test` (node --test).
// These exercise the pure, DOM-free parts of the app: the question generator
// (quiz.js) and the spaced-repetition picker (srs.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, makeQuestion, createQuiz, shuffle, geoDistractors, ALL_MODES, drawWithoutRepeat, answerMatches } from '../js/quiz.js';
import { weightFor, pickWeighted, weakCount } from '../js/srs.js';
import { historicFlagUrl, stateFlagUrl } from '../js/data.js';

// A small synthetic dataset that mirrors the real JSON shape.
const data = {
  countries: [
    { name: 'Japan', iso2: 'JP', capital: 'Tokyo', region: 'Asia', subregion: 'East Asia', language: 'Japanese', religion: 'Shinto/Buddhism', funFact: 'Many islands.', wiki: 'https://w/Japan' },
    { name: 'France', iso2: 'FR', capital: 'Paris', region: 'Europe', subregion: 'Western Europe', language: 'French', religion: 'Christianity', funFact: 'Most visited.', wiki: 'https://w/France' },
    { name: 'Brazil', iso2: 'BR', capital: 'Brasília', region: 'South America', subregion: 'South America', language: 'Portuguese', religion: 'Christianity', funFact: 'Amazon.', wiki: 'https://w/Brazil' },
    { name: 'Egypt', iso2: 'EG', capital: 'Cairo', region: 'Africa', subregion: 'North Africa', language: 'Arabic', religion: 'Islam', funFact: 'Pyramids.', wiki: 'https://w/Egypt' },
    { name: 'Kenya', iso2: 'KE', capital: 'Nairobi', region: 'Africa', subregion: 'East Africa', language: 'Swahili', religion: 'Christianity', funFact: 'Safari.', wiki: 'https://w/Kenya' },
    { name: 'Tanzania', iso2: 'TZ', capital: 'Dodoma', region: 'Africa', subregion: 'East Africa', language: 'Swahili', religion: 'Christianity (Catholic)', funFact: 'Serengeti.', wiki: 'https://w/Tanzania' },
  ],
  usStates: [{ name: 'Colorado', capital: 'Denver', region: 'West', funFact: 'Mile high.', wiki: 'https://w/CO' }],
  mxStates: [{ name: 'Jalisco', capital: 'Guadalajara', region: 'West', funFact: 'Tequila.', wiki: 'https://w/JAL' }],
  caStates: [{ name: 'Alberta', capital: 'Edmonton', region: 'Prairies', funFact: 'Rockies.', wiki: 'https://w/AB' }],
  historicFlags: [
    { name: 'Soviet Union', img: 'Flag of the Soviet Union.svg', era: '1922–1991', region: 'Europe', funFact: 'Hammer and sickle.', wiki: 'https://w/USSR' },
    { name: 'Ottoman Empire', img: 'Flag of the Ottoman Empire.svg', era: '1844–1922', region: 'Asia', funFact: 'Crescent.', wiki: 'https://w/Ottoman' },
    { name: 'Rhodesia', img: 'Flag of Rhodesia.svg', era: '1968–1979', region: 'Africa', funFact: 'Became Zimbabwe.', wiki: 'https://w/Rhodesia' },
    { name: 'Yugoslavia', img: 'Flag of Yugoslavia.svg', era: '1946–1992', region: 'Europe', funFact: 'Six republics.', wiki: 'https://w/Yugoslavia' },
  ],
  similarFlags: [
    { group: 'Red-white-blue tricolours', tip: 'Orientation and shade differ.', countries: [
      { name: 'Netherlands', iso2: 'NL' }, { name: 'Luxembourg', iso2: 'LU' },
      { name: 'Russia', iso2: 'RU' }, { name: 'France', iso2: 'FR' } ] },
    { group: 'Black-yellow-red', tip: 'Belgium is vertical; Germany is horizontal.', countries: [
      { name: 'Belgium', iso2: 'BE' }, { name: 'Germany', iso2: 'DE' } ] },
  ],
  religions: [
    { name: 'Christianity', founder: 'Jesus of Nazareth', text: 'The Bible', symbol: 'Cross', holiday: 'Easter', worship: 'Church', origin: 'The Levant', funFact: 'Largest religion.', wiki: 'https://w/Christianity' },
    { name: 'Islam', founder: 'Prophet Muhammad', text: 'The Quran', symbol: 'Star and crescent', holiday: 'Eid al-Fitr', worship: 'Mosque', origin: 'Arabian Peninsula', funFact: 'Five daily prayers.', wiki: 'https://w/Islam' },
    { name: 'Buddhism', founder: 'Siddhartha Gautama', text: 'Tripitaka', symbol: 'Dharma wheel', holiday: 'Vesak', worship: 'Vihara (temple)', origin: 'Indian subcontinent', funFact: 'Path to nirvana.', wiki: 'https://w/Buddhism' },
    { name: 'Judaism', founder: 'Abraham', text: 'The Torah', symbol: 'Star of David', holiday: 'Passover', worship: 'Synagogue', origin: 'Ancient Israel and Judah', funFact: 'Torah scroll.', wiki: 'https://w/Judaism' },
  ],
};

test('buildPool covers every enabled mode', () => {
  const pool = buildPool(data, { modes: ALL_MODES, continents: 'all' });
  // 6 countries × 5 country-modes (capital, country, language, religion, flag)
  // + 4 religions × 6 religion-modes (founder, text, holiday, symbol, place, origin)
  // + 1 US + 1 MX + 1 CA + 4 historic flags + 6 similar-flag countries (4 + 2)
  assert.equal(pool.length, 6 * 5 + 4 * 6 + 1 + 1 + 1 + 4 + 6);
  assert.ok(pool.every((p) => p.id.includes(':')));
});

test('buildPool builds one item per Canadian province/territory for ca_capital', () => {
  const pool = buildPool(data, { modes: ['ca_capital'], continents: 'all' });
  assert.equal(pool.length, data.caStates.length);
  assert.equal(pool[0].region, 'North America');
  assert.equal(pool[0].id, 'ca_capital:Alberta');
});

test('makeQuestion (ca_capital) mirrors the US/MX state-capital modes', () => {
  const item = { id: 'ca_capital:Alberta', mode: 'ca_capital', region: 'North America', source: data.caStates[0] };
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.answer, 'Edmonton');
  assert.match(q.prompt, /capital of Alberta/);
  assert.ok(q.choices.includes('Edmonton'));
  assert.equal(q.choices.length, 4);
});

test('buildPool filters by continent for country modes', () => {
  const pool = buildPool(data, { modes: ['capital'], continents: ['Africa'] });
  assert.equal(pool.length, 3); // Egypt + Kenya + Tanzania
});

test('buildPool builds one item per historic flag', () => {
  const pool = buildPool(data, { modes: ['historic_flag'], continents: 'all' });
  assert.equal(pool.length, data.historicFlags.length);
  assert.ok(pool.every((p) => p.mode === 'historic_flag'));
  assert.ok(pool.some((p) => p.id === 'historic_flag:Soviet Union'));
});

test('makeQuestion (capital) has correct answer among the choices', () => {
  const item = { id: 'capital:Japan', mode: 'capital', region: 'Asia', source: data.countries[0] };
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.answer, 'Tokyo');
  assert.equal(q.prompt, 'What is the capital of Japan?');
  assert.ok(q.choices.includes('Tokyo'));
  assert.equal(q.choices.length, 4);
  assert.equal(new Set(q.choices).size, 4, 'choices are unique');
});

test('makeQuestion (country) inverts the relationship', () => {
  const item = { id: 'country:France', mode: 'country', region: 'Europe', source: data.countries[1] };
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.answer, 'France');
  assert.match(q.prompt, /capital Paris/);
});

test('makeQuestion (flag) exposes an iso2 for the image', () => {
  const item = { id: 'flag:Brazil', mode: 'flag', region: 'South America', source: data.countries[2] };
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.flagIso, 'BR');
  assert.equal(q.answer, 'Brazil');
});

test('makeQuestion (historic_flag) carries an image filename and entity answer', () => {
  const item = { id: 'historic_flag:Soviet Union', mode: 'historic_flag', region: 'Europe', source: data.historicFlags[0] };
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.answer, 'Soviet Union');
  assert.equal(q.prompt, 'Which nation flew this flag?');
  assert.equal(q.flagImg, 'Flag of the Soviet Union.svg');
  assert.ok(!q.flagIso, 'historic flags use flagImg, not flagIso');
  assert.ok(q.choices.includes('Soviet Union'));
  assert.equal(q.choices.length, 4);
});

test('makeQuestion (historic_flag) draws distractors only from historic entities', () => {
  const item = { id: 'historic_flag:Soviet Union', mode: 'historic_flag', region: 'Europe', source: data.historicFlags[0] };
  const q = makeQuestion(item, data, { choices: 4 });
  const historicNames = new Set(data.historicFlags.map((h) => h.name));
  assert.ok(q.choices.every((c) => historicNames.has(c)), 'every choice is a historic entity');
});

test('buildPool builds one item per country across similar-flag groups', () => {
  const pool = buildPool(data, { modes: ['similar_flag'], continents: 'all' });
  assert.equal(pool.length, 6); // 4 in the tricolour group + 2 in black-yellow-red
  assert.ok(pool.every((p) => p.mode === 'similar_flag'));
  assert.ok(pool.some((p) => p.id === 'similar_flag:Netherlands'));
  // Each item carries its look-alike group so distractors stay confusable.
  const nl = pool.find((p) => p.id === 'similar_flag:Netherlands');
  assert.deepEqual([...nl.group].sort(), ['France', 'Luxembourg', 'Netherlands', 'Russia']);
});

test('similar-flag items ignore the continent filter (groups span the globe)', () => {
  const pool = buildPool(data, { modes: ['similar_flag'], continents: ['Africa'] });
  assert.equal(pool.length, 6);
});

test('makeQuestion (similar_flag) shows the flag and answers with the country', () => {
  const pool = buildPool(data, { modes: ['similar_flag'] });
  const item = pool.find((p) => p.id === 'similar_flag:Netherlands');
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.answer, 'Netherlands');
  assert.equal(q.flagIso, 'NL');
  assert.ok(!q.flagImg, 'current-country flags use flagIso, not flagImg');
  assert.equal(q.prompt, 'These flags all look alike — which country is this?');
  assert.ok(q.choices.includes('Netherlands'));
  assert.equal(q.choices.length, 4);
  assert.equal(new Set(q.choices).size, 4, 'choices are unique');
});

test('makeQuestion (similar_flag) draws distractors from the same look-alike group', () => {
  const pool = buildPool(data, { modes: ['similar_flag'] });
  const item = pool.find((p) => p.id === 'similar_flag:Netherlands');
  const q = makeQuestion(item, data, { choices: 4 });
  const groupNames = new Set(['Netherlands', 'Luxembourg', 'Russia', 'France']);
  assert.ok(q.choices.every((c) => groupNames.has(c)), 'every option is a group member');
});

test('makeQuestion (similar_flag) tops up a short group with other look-alike flags, never random countries', () => {
  const pool = buildPool(data, { modes: ['similar_flag'] });
  const item = pool.find((p) => p.id === 'similar_flag:Belgium');
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.choices.length, 4);
  assert.ok(q.choices.includes('Germany'), 'the same-group partner stays an option');
  const similarNames = new Set(data.similarFlags.flatMap((g) => g.countries.map((c) => c.name)));
  assert.ok(q.choices.every((c) => similarNames.has(c)), 'top-ups are still confusable flags');
  const unrelated = new Set(data.countries.map((c) => c.name)); // Japan, Brazil, …
  assert.ok(!q.choices.some((c) => unrelated.has(c) && !similarNames.has(c)), 'no plain random country leaks in');
});

test('makeQuestion (similar_flag) surfaces the group tip as the fun fact', () => {
  const pool = buildPool(data, { modes: ['similar_flag'] });
  const item = pool.find((p) => p.id === 'similar_flag:Germany');
  const q = makeQuestion(item, data, {});
  assert.equal(q.funFact, 'Belgium is vertical; Germany is horizontal.');
  assert.ok(q.learnMore.some((l) => l.label === 'Wikipedia'));
});

test('buildPool builds one item per religion for each religion mode', () => {
  const pool = buildPool(data, { modes: ['religion_founder'], continents: 'all' });
  assert.equal(pool.length, data.religions.length);
  assert.ok(pool.every((p) => p.mode === 'religion_founder' && p.region === 'World'));
  assert.ok(pool.some((p) => p.id === 'religion_founder:Buddhism'));
});

test('religion modes ignore the continent filter (religions are global)', () => {
  const pool = buildPool(data, { modes: ['religion_text'], continents: ['Africa'] });
  assert.equal(pool.length, data.religions.length);
});

test('makeQuestion (religion_founder) has the right answer among the choices', () => {
  const item = { id: 'religion_founder:Buddhism', mode: 'religion_founder', region: 'World', source: data.religions[2] };
  const q = makeQuestion(item, data, { choices: 4 });
  assert.equal(q.answer, 'Siddhartha Gautama');
  assert.match(q.prompt, /Buddhism/);
  assert.ok(q.choices.includes('Siddhartha Gautama'));
  assert.equal(q.choices.length, 4);
  assert.equal(new Set(q.choices).size, 4, 'choices are unique');
});

test('makeQuestion (religion_text / religion_holiday) draw from the right field', () => {
  const textQ = makeQuestion(
    { id: 'religion_text:Islam', mode: 'religion_text', region: 'World', source: data.religions[1] },
    data, { choices: 4 });
  assert.equal(textQ.answer, 'The Quran');
  assert.ok(textQ.choices.includes('The Quran'));

  const holidayQ = makeQuestion(
    { id: 'religion_holiday:Judaism', mode: 'religion_holiday', region: 'World', source: data.religions[3] },
    data, { choices: 4 });
  assert.equal(holidayQ.answer, 'Passover');
  assert.ok(holidayQ.choices.includes('Passover'));
});

test('makeQuestion (religion_symbol / religion_place / religion_origin) draw from the right field', () => {
  const symbolQ = makeQuestion(
    { id: 'religion_symbol:Judaism', mode: 'religion_symbol', region: 'World', source: data.religions[3] },
    data, { choices: 4 });
  assert.equal(symbolQ.answer, 'Star of David');
  assert.match(symbolQ.prompt, /Judaism/);
  assert.ok(symbolQ.choices.includes('Star of David'));
  assert.equal(symbolQ.choices.length, 4);
  assert.equal(new Set(symbolQ.choices).size, 4, 'choices are unique');

  const placeQ = makeQuestion(
    { id: 'religion_place:Islam', mode: 'religion_place', region: 'World', source: data.religions[1] },
    data, { choices: 4 });
  assert.equal(placeQ.answer, 'Mosque');
  assert.match(placeQ.prompt, /Islam/);
  assert.ok(placeQ.choices.includes('Mosque'));
  assert.equal(placeQ.choices.length, 4);

  const originQ = makeQuestion(
    { id: 'religion_origin:Buddhism', mode: 'religion_origin', region: 'World', source: data.religions[2] },
    data, { choices: 4 });
  assert.equal(originQ.answer, 'Indian subcontinent');
  assert.match(originQ.prompt, /Buddhism/);
  assert.ok(originQ.choices.includes('Indian subcontinent'));
});

test('new religion modes keep distractors within the religion set', () => {
  const q = makeQuestion(
    { id: 'religion_place:Christianity', mode: 'religion_place', region: 'World', source: data.religions[0] },
    data, { choices: 4 });
  const places = new Set(data.religions.map((r) => r.worship));
  assert.ok(q.choices.every((c) => places.has(c)), 'every choice is a known place of worship');
});

test('a single-faith session now offers at least 6 distinct questions', () => {
  const pool = buildPool(data, { modes: ALL_MODES, religionFilter: 'Buddhism' });
  const buddhist = pool.filter((p) => p.source.name === 'Buddhism' && p.region === 'World');
  assert.equal(buddhist.length, 6, 'founder, text, holiday, symbol, place, origin');
});

test('makeQuestion (religion) keeps distractors within the religion set, not country names', () => {
  const item = { id: 'religion_founder:Christianity', mode: 'religion_founder', region: 'World', source: data.religions[0] };
  const q = makeQuestion(item, data, { choices: 4 });
  const founders = new Set(data.religions.map((r) => r.founder));
  assert.ok(q.choices.every((c) => founders.has(c)), 'every choice is a known religious figure');
  const countryNames = new Set(data.countries.map((c) => c.name));
  assert.ok(!q.choices.some((c) => countryNames.has(c)), 'no country names leak in as distractors');
});

test('makeQuestion (religion) links to Wikipedia but not the World Factbook', () => {
  const item = { id: 'religion_text:Buddhism', mode: 'religion_text', region: 'World', source: data.religions[2] };
  const q = makeQuestion(item, data, {});
  assert.ok(q.learnMore.some((l) => l.label === 'Wikipedia'));
  assert.ok(!q.learnMore.some((l) => l.label === 'World Factbook'), 'no Factbook link for religions');
});

test('makeQuestion (historic_flag) links to Wikipedia but not the World Factbook', () => {
  const item = { id: 'historic_flag:Ottoman Empire', mode: 'historic_flag', region: 'Asia', source: data.historicFlags[1] };
  const q = makeQuestion(item, data, {});
  assert.ok(q.learnMore.some((l) => l.label === 'Wikipedia'));
  assert.ok(!q.learnMore.some((l) => l.label === 'World Factbook'), 'no Factbook link for historic entities');
});

test('makeQuestion always provides a fun fact and learn-more links', () => {
  const item = { id: 'capital:Egypt', mode: 'capital', region: 'Africa', source: data.countries[3] };
  const q = makeQuestion(item, data, {});
  assert.ok(q.funFact.length > 0);
  assert.ok(q.learnMore.some((l) => l.label === 'Wikipedia'));
  assert.ok(q.learnMore.some((l) => l.label === 'World Factbook'));
});

test('historicFlagUrl builds a stable Wikimedia Special:FilePath URL', () => {
  const url = historicFlagUrl('Flag of the Soviet Union.svg');
  assert.match(url, /commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
  assert.match(url, /Flag%20of%20the%20Soviet%20Union\.svg/);
  assert.match(url, /width=320/);
});

test('stateFlagUrl builds a stable Wikimedia Special:FilePath URL', () => {
  const url = stateFlagUrl('Flag of Alabama.svg');
  assert.match(url, /commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
  assert.match(url, /Flag%20of%20Alabama\.svg/);
  assert.match(url, /width=320/);
});

test('createQuiz restricted to reviewIds only asks those items', () => {
  const reviewIds = ['capital:Japan', 'flag:Brazil'];
  const quiz = createQuiz({ data, reviewIds });
  assert.equal(quiz.size, 2);
  for (let i = 0; i < 10; i++) {
    const q = quiz.next();
    assert.ok(reviewIds.includes(q.id));
  }
});

test('shuffle is a permutation (keeps every element)', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, () => 0.42);
  assert.deepEqual([...out].sort(), input);
  assert.equal(out.length, input.length);
});

test('SRS weights unseen items moderately and missed items heavily', () => {
  const srs = {
    seen_ok: { box: 5, correct: 9, wrong: 0, lastSeen: Date.now() },
    missed: { box: 0, correct: 0, wrong: 3, lastSeen: 0 },
  };
  const wUnseen = weightFor('brand_new', srs);
  const wMissed = weightFor('missed', srs);
  const wKnown = weightFor('seen_ok', srs);
  assert.ok(wMissed > wUnseen, 'missed items outrank unseen');
  assert.ok(wUnseen > wKnown, 'unseen items outrank freshly-mastered ones');
});

test('pickWeighted is deterministic with an injected rng and honours weights', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const srs = { a: { box: 0, correct: 0, wrong: 4, lastSeen: 0 } }; // a is heavy
  // rng=0 should land in the first (heaviest) bucket.
  const chosen = pickWeighted(pool, srs, () => 0);
  assert.equal(chosen.id, 'a');
});

test('weakCount tallies low-box missed items', () => {
  const srs = {
    a: { box: 0, correct: 0, wrong: 2, lastSeen: 0 },
    b: { box: 4, correct: 5, wrong: 1, lastSeen: 0 },
    c: { box: 1, correct: 1, wrong: 1, lastSeen: 0 },
  };
  assert.equal(weakCount(srs), 2); // a and c
});

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

test('geoDistractors with a normalize function treats same-base variants as duplicates', () => {
  const kenya = data.countries.find((c) => c.name === 'Kenya');
  // Tanzania is Kenya's only East Africa subregion-mate, but now has
  // "Christianity (Catholic)" vs Kenya's plain "Christianity" — without
  // normalization these look like different answers; with normalization
  // (strip the parenthetical) they're recognized as the same base religion
  // and Tanzania must NOT be offered as a distractor for Kenya.
  const baseReligion = (v) => String(v).split(/[/(]/)[0].trim();
  const picks = geoDistractors(data.countries, kenya, 'religion', 1, () => 0.5, baseReligion);
  assert.equal(picks.length, 1);
  assert.notEqual(picks[0], 'Christianity (Catholic)', 'same-base Tanzania is excluded even though the exact string differs');
  // Falls through to the region tier (Africa) or beyond to find a genuinely
  // different religion (Egypt's "Islam").
  assert.equal(picks[0], 'Islam');
});

test('makeQuestion (religion) with normalize does not offer a same-base-religion variant as a distractor', () => {
  const kenya = data.countries.find((c) => c.name === 'Kenya');
  const q = makeQuestion({ id: 'religion:Kenya', mode: 'religion', region: 'Africa', source: kenya }, data, { choices: 2 });
  assert.equal(q.choices.length, 2);
  assert.ok(q.choices.includes('Christianity'), 'the answer is present');
  assert.ok(!q.choices.includes('Christianity (Catholic)'), 'Tanzania is NOT offered — same base religion as the answer');
});

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

// ---- no-duplicate sessions (the core fix) ----------------------------------

test('a session never repeats a question until the pool is exhausted', () => {
  // historic_flag pool has 4 items; four draws must be four distinct questions.
  for (const mode of ['historic_flag', 'similar_flag', 'capital', 'religion_founder']) {
    const quiz = createQuiz({ data, config: { modes: [mode] } });
    const seen = new Set();
    for (let i = 0; i < quiz.size; i++) {
      const q = quiz.next();
      assert.ok(q, `${mode} should yield a question`);
      assert.ok(!seen.has(q.id), `${mode} repeated ${q.id} within the pool`);
      seen.add(q.id);
    }
    assert.equal(seen.size, quiz.size, `${mode} covered its whole pool without repeats`);
  }
});

test('a session longer than the pool recycles without an immediate repeat', () => {
  const quiz = createQuiz({ data, config: { modes: ['historic_flag'] } }); // size 4
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(quiz.next().id);
  // No two consecutive questions are identical, even across the recycle seam.
  for (let i = 1; i < ids.length; i++) {
    assert.notEqual(ids[i], ids[i - 1], `consecutive repeat at index ${i}`);
  }
  // Every 4-question window is a full, distinct sweep of the pool.
  assert.equal(new Set(ids.slice(0, 4)).size, 4);
  assert.equal(new Set(ids.slice(4, 8)).size, 4);
});

test('drawWithoutRepeat exhausts the pool before repeating, then clears', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const state = { asked: new Set(), lastId: null };
  const first = [drawWithoutRepeat(pool, state), drawWithoutRepeat(pool, state), drawWithoutRepeat(pool, state)];
  assert.deepEqual([...first.map((x) => x.id)].sort(), ['a', 'b', 'c']);
  assert.equal(state.asked.size, 3);
  const next = drawWithoutRepeat(pool, state); // pool exhausted → recycles
  assert.notEqual(next.id, first[2].id, 'no immediate repeat at the recycle seam');
});

// ---- typed-answer matcher ---------------------------------------------------

test('answerMatches is accent- and case-insensitive and trims/normalizes', () => {
  assert.ok(answerMatches('tokyo', 'Tokyo'));
  assert.ok(answerMatches('  UNITED   states ', 'United States'));
  assert.ok(answerMatches("cote d'ivoire", 'Côte d’Ivoire'));
  assert.ok(answerMatches('brasilia', 'Brasília'));
  assert.ok(!answerMatches('paris', 'London'));
  assert.ok(!answerMatches('', 'Tokyo'), 'empty input is never a match');
});

test('answerMatches tolerates spacing differences from stripped punctuation', () => {
  assert.ok(answerMatches('washington dc', 'Washington, D.C.'), 'D.C. abbreviation');
  assert.ok(answerMatches('washington d c', 'Washington, D.C.'));
  assert.ok(answerMatches("st johns", "St. John's"), 'possessive + abbreviation');
  assert.ok(!answerMatches('washington', 'Washington, D.C.'), 'missing part still fails');
});

// ---- per-religion filter (World Religions "pick a faith") ------------------

test('buildPool honours religionFilter for religion modes', () => {
  const pool = buildPool(data, { modes: ['religion_founder', 'religion_text'], religionFilter: 'Islam' });
  assert.equal(pool.length, 2, 'one item per religion mode, filtered to Islam');
  assert.ok(pool.every((p) => p.source.name === 'Islam'));
});
