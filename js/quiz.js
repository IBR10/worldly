// quiz.js — the question-generation engine.
//
// Given the datasets and a configuration (which modes, which continents, which
// difficulty), this builds a pool of "askable items" and turns any item into a
// multiple-choice question with a correct answer, three distractors, a fun fact
// and "learn more" links. It has no DOM dependencies so it can be exercised by
// the Node test suite.

export const MODES = {
  capital: { label: 'Country → Capital', source: 'country' },
  country: { label: 'Capital → Country', source: 'country' },
  language: { label: 'Country → Language', source: 'country' },
  religion: { label: 'Country → Religion', source: 'country' },
  currency: { label: 'Country → Currency', source: 'country' },
  population: { label: 'Country → Population', source: 'country' },
  religion_founder: { label: 'Religion → Founder', source: 'religion' },
  religion_text: { label: 'Religion → Holy Text', source: 'religion' },
  religion_holiday: { label: 'Religion → Major Holiday', source: 'religion' },
  religion_symbol: { label: 'Religion → Symbol', source: 'religion' },
  religion_place: { label: 'Religion → Place of Worship', source: 'religion' },
  religion_origin: { label: 'Religion → Origin', source: 'religion' },
  us_capital: { label: 'US State → Capital', source: 'us' },
  mx_capital: { label: 'Mexico State → Capital', source: 'mx' },
  ca_capital: { label: 'Canada Province → Capital', source: 'ca' },
  flag: { label: 'Flag → Country', source: 'country' },
  historic_flag: { label: 'Historic Flags', source: 'historic' },
  similar_flag: { label: 'Similar Flags', source: 'similar' },
};

export const ALL_MODES = Object.keys(MODES);

// ---- small helpers (rng injectable for deterministic tests) -----------------

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Challenge/Daily session scoring (server + client share this exactly) --

/** Speed/streak multiplier for the question about to be answered, given the
 *  in-session streak going INTO it. Capped at 3x. Session-only — never uses
 *  the player's lifetime streak, so it's safe for a server to recompute. */
export function challengeMultiplier(runStreakBeforeQuestion) {
  return 1 + Math.min(2, runStreakBeforeQuestion * 0.2);
}

/** XP earned for one question in a Challenge/Daily session, given the streak
 *  going INTO the question and whether it was answered correctly. Mirrors the
 *  shape of state.js's lifetime-XP formula but is entirely self-contained —
 *  no dependency on private profile state — so client and server always agree. */
export function sessionQuestionXp(runStreakBeforeQuestion, correct) {
  if (!correct) return 0;
  const streakAfter = runStreakBeforeQuestion + 1;
  const bonus = Math.min(10, Math.floor(streakAfter / 2));
  return Math.round((10 + bonus) * challengeMultiplier(runStreakBeforeQuestion));
}

// ---- Seeded RNG (mulberry32) — moved here from main.js so the server can ----
// ---- import the exact same implementation the client uses. -----------------

/** Deterministic RNG from a numeric seed, so the Daily Challenge is identical
 *  for everyone who plays it (client and server alike). */
export function seededRng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Numeric seed from a "yyyy-mm-dd" date string — same date string always
 *  yields the same seed. The caller decides which date string to use (the
 *  client passes its local date; the server passes its own UTC date). */
export function dateSeed(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) | 0;
  return h;
}

export function sampleDistinct(values, exclude, n, rng) {
  const pool = [...new Set(values)].filter((v) => v && v !== exclude);
  return shuffle(pool, rng).slice(0, n);
}

/**
 * Distractor VALUES for a country-based question, preferring answers from
 * geographically nearby countries so wrong choices can't be eliminated just
 * by "that's obviously not even on the right continent." Draws from the
 * target's subregion first, tops up from its region if the subregion doesn't
 * have enough distinct values, and finally tops up from the whole country
 * list — so every question always gets `n` distractors, even for countries
 * in very sparse subregions/regions.
 *
 * `normalize` controls what counts as "the same value" for exclusion/dedup
 * purposes (default: exact string match). Some fields have near-duplicate
 * variants that are all effectively the same answer — e.g. religion values
 * like "Christianity", "Christianity (Catholic)", "Christianity/Irreligion"
 * are all Christianity-family, and offering one as a wrong answer for a
 * country whose real answer is another is unfair, not merely close. Pass a
 * normalize function (e.g. one that strips a parenthetical/slash qualifier)
 * to treat same-base variants as duplicates for selection purposes while
 * still returning their original, unnormalized text as the distractor.
 */
export function geoDistractors(countries, target, field, n, rng, normalize = (v) => v) {
  const targetNorm = normalize(target[field]);
  const chosen = [];
  const chosenNorm = [];
  const tiers = [
    countries.filter((x) => x !== target && x.subregion === target.subregion),
    countries.filter((x) => x !== target && x.region === target.region),
    countries,
  ];
  for (const tier of tiers) {
    if (chosen.length >= n) break;
    // Dedupe by normalized form so two same-base variants (e.g. "Islam" and
    // "Islam (Shia)") can't both slip in as if they were different answers.
    const seenNorm = new Set();
    const candidates = tier
      .map((x) => x[field])
      .filter((v) => v && normalize(v) !== targetNorm && !chosenNorm.includes(normalize(v)))
      .filter((v) => {
        const nv = normalize(v);
        if (seenNorm.has(nv)) return false;
        seenNorm.add(nv);
        return true;
      });
    const picked = sampleDistinct(candidates, target[field], n - chosen.length, rng);
    picked.forEach((v) => chosenNorm.push(normalize(v)));
    chosen.push(...picked);
  }
  return chosen;
}

// Accent- and case-insensitive comparison for the typed-answer mode. Folds
// diacritics, lowercases, and collapses punctuation/whitespace so "Cote d'Ivoire"
// matches "Côte d’Ivoire" and "  united  states " matches "United States".
export function answerMatches(input, answer) {
  const norm = (s) => String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,'’`()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!input) return false;
  const a = norm(input), b = norm(answer);
  if (b === '') return false;
  // Also compare with spaces removed, so punctuation-derived spacing can't
  // fail a correct answer ("washington dc" vs "Washington, D.C." → "d c").
  return a === b || a.replace(/ /g, '') === b.replace(/ /g, '');
}

/**
 * Draw one item from `pool` without repeating within a session. `state` carries
 * `{ asked:Set, lastId }` across calls: we sample only from items not yet asked,
 * and once the pool is exhausted we recycle (clearing `asked`) while still
 * avoiding an immediate repeat of the last item at the seam. Shared by the MCQ
 * engine (createQuiz) and the click-the-map engine so both stay in lock-step.
 */
export function drawWithoutRepeat(pool, state, { pick = null, rng = Math.random, srsMap = {} } = {}) {
  if (!pool.length) return null;
  let candidates = pool.filter((it) => !state.asked.has(it.id));
  if (candidates.length === 0) {
    state.asked.clear();
    candidates = pool.filter((it) => it.id !== state.lastId);
    if (candidates.length === 0) candidates = pool.slice();
  }
  const item = pick ? pick(candidates, srsMap) : candidates[Math.floor(rng() * candidates.length)];
  if (item) { state.asked.add(item.id); state.lastId = item.id; }
  return item;
}

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[.,'()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// English-Wikipedia article URL for a country name (spaces → underscores).
// Wikipedia resolves diacritics and common aliases via redirects.
function wikiUrl(name) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`;
}

// Exported so the map modes (maps.js) can build the same "learn more" links.
export function learnMoreFor(source, isCountry) {
  const links = [{ label: 'Wikipedia', url: source.wiki }];
  if (isCountry) {
    links.push({
      label: 'World Factbook',
      url: `https://www.cia.gov/the-world-factbook/countries/${slug(source.name)}/`,
    });
  }
  links.push({
    label: 'Culture Guide',
    url: `https://www.google.com/search?q=${encodeURIComponent('culture of ' + source.name)}`,
  });
  return links;
}

// ---- pool construction -------------------------------------------------------

/**
 * Build the complete list of askable items for the given modes/continents.
 * Each item carries the data needed to render a question later.
 */
export function buildPool(data, { modes = ALL_MODES, continents = 'all', religionFilter = null } = {}) {
  const pool = [];
  const countryOK = (c) => continents === 'all' || continents.includes(c.region);

  for (const mode of modes) {
    const src = MODES[mode]?.source;
    if (!src) continue;
    if (src === 'country') {
      for (const c of data.countries) {
        if (!countryOK(c)) continue;
        if (mode === 'flag' && !c.iso2) continue;
        pool.push({ id: `${mode}:${c.name}`, mode, region: c.region, source: c });
      }
    } else if (src === 'us') {
      for (const s of data.usStates) {
        pool.push({ id: `${mode}:${s.name}`, mode, region: 'North America', source: s });
      }
    } else if (src === 'mx') {
      for (const s of data.mxStates) {
        pool.push({ id: `${mode}:${s.name}`, mode, region: 'North America', source: s });
      }
    } else if (src === 'ca') {
      for (const s of data.caStates) {
        pool.push({ id: `${mode}:${s.name}`, mode, region: 'North America', source: s });
      }
    } else if (src === 'historic') {
      for (const h of data.historicFlags || []) {
        pool.push({ id: `${mode}:${h.name}`, mode, region: h.region, source: h });
      }
    } else if (src === 'similar') {
      // One item per country in each look-alike group. The item carries the
      // group's members (so distractors stay within the confusable set) and the
      // distinguishing tip (surfaced as the fun fact).
      for (const g of data.similarFlags || []) {
        for (const c of g.countries) {
          pool.push({
            id: `${mode}:${c.name}`,
            mode,
            region: 'World',
            source: { ...c, funFact: g.tip, wiki: c.wiki || wikiUrl(c.name) },
            group: g.countries.map((x) => x.name),
          });
        }
      }
    } else if (src === 'religion') {
      for (const r of data.religions || []) {
        // Optional single-faith filter for the World Religions "pick a faith" mode.
        if (religionFilter && r.name !== religionFilter) continue;
        pool.push({ id: `${mode}:${r.name}`, mode, region: 'World', source: r });
      }
    }
  }
  return pool;
}

// ---- question construction ---------------------------------------------------

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
    case 'currency':
      prompt = `What is the official currency of ${c.name}?`;
      answer = c.currency;
      break;
    case 'population':
      prompt = `What is the population of ${c.name}?`;
      answer = c.population;
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
    case 'ca_capital':
      prompt = `What is the capital of ${c.name}? (Canadian province/territory)`;
      answer = c.capital;
      distractorValues = data.caStates.map((x) => x.capital);
      isCountry = false;
      break;
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  // The five country-based modes always draw distractors from nearby
  // countries (same subregion, falling back to region, falling back to the
  // whole world) so wrong answers can't be eliminated just by "that's not
  // even close." This applies unconditionally, regardless of `difficulty`.
  const GEO_FIELD = { capital: 'capital', country: 'name', language: 'language', religion: 'religion', currency: 'currency', population: 'population', flag: 'name' };
  const geoField = GEO_FIELD[mode];
  let distractors;
  if (geoField) {
    // Religion strings carry qualifiers ("Christianity (Catholic)",
    // "Christianity/Irreligion") that are all the same base religion —
    // normalize to the text before "(" or "/" so same-base variants don't
    // count as valid distractors for each other (see geoDistractors' doc).
    const normalize = mode === 'religion' ? (v) => String(v).split(/[/(]/)[0].trim() : undefined;
    distractors = geoDistractors(data.countries, c, geoField, choices - 1, rng, normalize);
    // Population is numeric — format both the answer and its distractors as
    // comma-grouped strings only after distractor selection, so proximity
    // selection above still compares real numbers, not formatted text.
    if (mode === 'population') {
      answer = answer.toLocaleString('en-US');
      distractors = distractors.map((n) => n.toLocaleString('en-US'));
    }
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

// ---- engine ------------------------------------------------------------------

/**
 * Create a stateful quiz session.
 * @param {object} cfg
 *   data        the loaded datasets
 *   config      { modes, continents, difficulty, choices }
 *   srsMap      spaced-repetition records (for weighting); optional
 *   reviewIds   if provided, restrict the pool to these item ids (review mode)
 *   pick        injectable weighted-picker (item, pool) for tests
 */
export function createQuiz({ data, config = {}, srsMap = {}, reviewIds = null, pick = null, rng = Math.random }) {
  let pool = buildPool(data, config);
  if (reviewIds && reviewIds.length) {
    const set = new Set(reviewIds);
    // Reconstruct review items from the full unfiltered pool so any missed item
    // can be revisited regardless of the current continent filter.
    const full = buildPool(data, { modes: ALL_MODES, continents: 'all' });
    pool = full.filter((it) => set.has(it.id));
  }

  // Session state for no-repeat sampling (see drawWithoutRepeat).
  const state = { asked: new Set(), lastId: null };
  return {
    size: pool.length,
    next() {
      const item = drawWithoutRepeat(pool, state, { pick, rng, srsMap });
      if (!item) return null;
      return makeQuestion(item, data, { ...config, rng });
    },
  };
}
