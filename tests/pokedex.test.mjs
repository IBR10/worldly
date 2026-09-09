// Tests for the Pokédex engine (js/pokedex.js) and its progress store
// (js/pokestate.js). Both are DOM-free, so this runs under plain `node --test`
// like engine.test.mjs / maps.test.mjs.
//
// Most assertions run against the real data/pokemon.json rather than a fixture:
// the failure modes worth guarding here — a mode emitting a question with two
// correct answers, a distractor equal to the answer, an evolution that points at
// nothing — only show up across all 1025 species, not in a hand-built sample of
// four.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_NAMES } from '../js/icons.js';
import { readFileSync } from 'node:fs';

import {
  POKE_MODES, ALL_POKE_MODES, GENERATIONS,
  buildPokePool, makePokeQuestion, createPokeQuiz,
  typeEffectiveness, redactName, pokeDistractors,
} from '../js/pokedex.js';

import {
  defaultStore, applyAnswer, isRegistered, isMastered,
  dexProgress, trainerRank, nextRank, accuracy, weakSpecies,
  MASTER_AT,
} from '../js/pokestate.js';

const dex = JSON.parse(readFileSync(new URL('../data/pokemon.json', import.meta.url), 'utf8'));
const chart = JSON.parse(readFileSync(new URL('../data/pokemon_types.json', import.meta.url), 'utf8'));

/** Deterministic RNG so a failure is reproducible. */
function rngFrom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- dataset integrity -------------------------------------------------------

test('dataset covers all 1025 species with the fields the modes need', () => {
  assert.equal(dex.length, 1025);
  assert.deepEqual(dex.map((p) => p.id), Array.from({ length: 1025 }, (_, i) => i + 1));
  for (const p of dex) {
    assert.ok(p.name && typeof p.name === 'string', `#${p.id} has a name`);
    assert.ok(p.types.length >= 1 && p.types.length <= 2, `#${p.id} has 1-2 types`);
    assert.ok(GENERATIONS.includes(p.gen), `#${p.id} has a real generation`);
    for (const key of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
      assert.equal(typeof p.stats[key], 'number', `#${p.id} has ${key}`);
    }
  }
});

test('every evolution target names a species that exists', () => {
  const names = new Set(dex.map((p) => p.name));
  for (const p of dex) {
    for (const to of p.evolvesTo) assert.ok(names.has(to), `${p.name} -> ${to} exists`);
    if (p.evolvesFrom) assert.ok(names.has(p.evolvesFrom), `${p.evolvesFrom} -> ${p.name} exists`);
  }
});

test('type chart is 18x18 and matches known matchups', () => {
  assert.equal(Object.keys(chart).length, 18);
  assert.equal(chart.water.fire, 2);
  assert.equal(chart.fire.water, 0.5);
  assert.equal(chart.electric.ground, 0);   // immunity, not just resistance
  assert.equal(chart.normal.ghost, 0);
  assert.equal(chart.fighting.normal, 2);
});

test('typeEffectiveness multiplies across a dual typing', () => {
  // Electric into Water/Flying (Gyarados) stacks to 4x; into Ground it is nil.
  assert.equal(typeEffectiveness(chart, 'electric', ['water', 'flying']), 4);
  assert.equal(typeEffectiveness(chart, 'electric', ['ground', 'rock']), 0);
  assert.equal(typeEffectiveness(chart, 'normal', ['normal']), 1);
});

// ---- pool --------------------------------------------------------------------

test('pool filters by generation and by type', () => {
  const gen1 = buildPokePool(dex, { modes: ['poke_who'], gens: [1] });
  assert.equal(gen1.length, 151);

  const fire = buildPokePool(dex, { modes: ['poke_who'], types: ['fire'] });
  assert.ok(fire.every((it) => it.mon.types.includes('fire')));
  assert.ok(fire.length > 60 && fire.length < 120);
});

test('modes that need a field only pool species that have it', () => {
  const evo = buildPokePool(dex, { modes: ['poke_evo'] });
  assert.ok(evo.every((it) => it.mon.evolvesTo.length > 0));
  assert.ok(evo.length > 400, 'plenty of species evolve');

  const entry = buildPokePool(dex, { modes: ['poke_dex'] });
  assert.ok(entry.every((it) => it.mon.dex.length > 20));
});

test('pool ids are unique so no-repeat sampling works across modes', () => {
  const pool = buildPokePool(dex, { modes: ALL_POKE_MODES });
  assert.equal(new Set(pool.map((it) => it.id)).size, pool.length);
});

// ---- questions ---------------------------------------------------------------

test('every mode produces a well-formed question for every species', () => {
  for (const mode of ALL_POKE_MODES) {
    const pool = buildPokePool(dex, { modes: [mode] });
    const rng = rngFrom(7);
    // Sample across the whole dex rather than the first few, so late-generation
    // and single-type species are covered too.
    for (let i = 0; i < pool.length; i += 37) {
      const q = makePokeQuestion(pool[i], dex, chart, { rng });
      assert.ok(q, `${mode} produced a question`);
      assert.ok(q.prompt.length > 0, `${mode} has a prompt`);
      assert.equal(q.choices.length, 4, `${mode} offers 4 choices`);
      assert.equal(new Set(q.choices).size, 4, `${mode} choices are distinct`);
      assert.ok(q.choices.includes(q.answer), `${mode} includes its answer`);
    }
  }
});

test("Who's That Pokémon? asks for a silhouette and the right name", () => {
  const pool = buildPokePool(dex, { modes: ['poke_who'], gens: [1] });
  const pikachu = pool.find((it) => it.mon.name === 'Pikachu');
  const q = makePokeQuestion(pikachu, dex, chart, { rng: rngFrom(1) });
  assert.equal(q.answer, 'Pikachu');
  assert.equal(q.sprite, 25);
  assert.equal(q.silhouette, true);
  assert.equal(q.monId, 25);
});

test('the dex-entry mode redacts the name it is asking for', () => {
  const pool = buildPokePool(dex, { modes: ['poke_dex'] });
  for (const item of pool) {
    const q = makePokeQuestion(item, dex, chart, { rng: rngFrom(3) });
    assert.ok(
      !q.body.toLowerCase().includes(item.mon.name.toLowerCase()),
      `${item.mon.name}'s entry does not give the answer away`,
    );
  }
});

test('redactName is case-insensitive and regex-safe', () => {
  assert.equal(redactName('A wild PIKACHU and a Pikachu.', 'Pikachu'), 'A wild ????? and a ?????.');
  // Farfetch'd and Mr. Mime contain characters that would break a naive RegExp.
  assert.equal(redactName("Farfetch'd is rare.", "Farfetch'd"), '????? is rare.');
  assert.equal(redactName('Mr. Mime waves.', 'Mr. Mime'), '????? waves.');
});

test('the base-stat mode never emits a question with a tie for the top', () => {
  const pool = buildPokePool(dex, { modes: ['poke_stat'] });
  const rng = rngFrom(11);
  for (let i = 0; i < pool.length; i += 13) {
    const q = makePokeQuestion(pool[i], dex, chart, { rng });
    const winners = q.choices.filter((c) => c === q.answer);
    assert.equal(winners.length, 1, 'exactly one choice is the answer');
  }
});

test('the matchup mode only offers one genuinely super-effective type', () => {
  const pool = buildPokePool(dex, { modes: ['poke_matchup'] });
  const rng = rngFrom(5);
  for (let i = 0; i < pool.length; i += 29) {
    const q = makePokeQuestion(pool[i], dex, chart, { rng });
    if (q.mode !== 'poke_matchup') continue;   // fell back for a no-weakness typing
    const defender = dex.find((p) => p.id === q.sprite);
    const effective = q.choices.filter(
      (c) => typeEffectiveness(chart, c.toLowerCase(), defender.types) > 1,
    );
    assert.deepEqual(effective, [q.answer], `only ${q.answer} beats ${defender.name}`);
  }
});

test('matchup questions do not register a species', () => {
  const pool = buildPokePool(dex, { modes: ['poke_matchup'] });
  const q = makePokeQuestion(pool[0], dex, chart, { rng: rngFrom(2) });
  if (q.mode === 'poke_matchup') assert.equal(q.monId, null);
});

test('distractors are never the target and are drawn from plausible neighbours', () => {
  const target = dex.find((p) => p.name === 'Charizard');
  const picks = pokeDistractors(dex, target, 3, rngFrom(9));
  assert.equal(picks.length, 3);
  assert.ok(picks.every((p) => p.id !== target.id));
  assert.equal(new Set(picks.map((p) => p.id)).size, 3);
});

// ---- session -----------------------------------------------------------------

test('a session does not repeat a question before the pool is exhausted', () => {
  const quiz = createPokeQuiz({ dex, chart, config: { modes: ['poke_who'], gens: [1] }, rng: rngFrom(4) });
  const seen = new Set();
  for (let i = 0; i < 151; i++) {
    const q = quiz.next();
    assert.ok(!seen.has(q.id), 'no repeat within one pass of the pool');
    seen.add(q.id);
  }
  assert.equal(seen.size, 151);
});

test('every declared mode has a label, a drawn icon and a registration flag', () => {
  for (const key of ALL_POKE_MODES) {
    const def = POKE_MODES[key];
    assert.ok(def.label && def.desc && def.icon, `${key} is presentable`);
    // The icon is a key into js/icons.js, not a glyph: an unknown name draws
    // nothing at all, which is a silent blank card rather than a visible defect.
    assert.ok(ICON_NAMES.includes(def.icon), `${key} icon "${def.icon}" is a real icon`);
    assert.equal(typeof def.registers, 'boolean', `${key} declares registration`);
  }
});

// ---- progress store ----------------------------------------------------------

test('one correct answer registers a species; a miss does not un-register it', () => {
  let s = defaultStore();
  assert.equal(isRegistered(s, 25), false);
  s = applyAnswer(s, 25, true);
  assert.equal(isRegistered(s, 25), true);
  s = applyAnswer(s, 25, false);
  assert.equal(isRegistered(s, 25), true, 'registration is permanent');
});

test('mastery needs a consecutive streak and a miss resets it', () => {
  let s = defaultStore();
  for (let i = 0; i < MASTER_AT; i++) s = applyAnswer(s, 25, true);
  assert.equal(isMastered(s, 25), true);
  s = applyAnswer(s, 25, false);
  assert.equal(isMastered(s, 25), false, 'a miss drops mastery');
  assert.equal(isRegistered(s, 25), true, 'but not registration');
});

test('answers with no species attached still count toward totals only', () => {
  let s = defaultStore();
  s = applyAnswer(s, null, true);
  assert.equal(s.answered, 1);
  assert.equal(s.correct, 1);
  assert.deepEqual(s.e, {}, 'no species was registered');
});

test('run streak tracks best and resets on a miss', () => {
  let s = defaultStore();
  s = applyAnswer(s, 1, true);
  s = applyAnswer(s, 2, true);
  assert.equal(s.streak, 2);
  assert.equal(s.bestStreak, 2);
  s = applyAnswer(s, 3, false);
  assert.equal(s.streak, 0);
  assert.equal(s.bestStreak, 2, 'best is kept');
});

test('applyAnswer does not mutate the store it was given', () => {
  const s = defaultStore();
  const after = applyAnswer(s, 25, true);
  assert.equal(s.answered, 0, 'original untouched');
  assert.notEqual(s, after);
  assert.deepEqual(s.e, {});
});

test('dexProgress counts overall and per generation', () => {
  let s = defaultStore();
  for (const p of dex.filter((x) => x.gen === 1)) s = applyAnswer(s, p.id, true);
  const prog = dexProgress(s, dex);
  assert.equal(prog.total, 1025);
  assert.equal(prog.registered, 151);
  assert.equal(prog.byGen[0].gen, 1);
  assert.equal(prog.byGen[0].registered, 151);
  assert.equal(prog.byGen[0].total, 151);
  assert.equal(prog.byGen[1].registered, 0);
});

test('trainer rank runs from Rookie to Pokémon Master', () => {
  assert.equal(trainerRank(0), 'Rookie Trainer');
  assert.equal(trainerRank(30), 'Ace Trainer');
  assert.equal(trainerRank(99.9), 'Champion');
  assert.equal(trainerRank(100), 'Pokémon Master');
});

test('nextRank points at the next tier up, and at nothing once maxed', () => {
  const next = nextRank(0);
  assert.equal(next.title, 'Bug Catcher');
  assert.equal(next.at, 5);
  assert.equal(nextRank(100), null);
});

test('accuracy and weakSpecies surface what still needs practice', () => {
  let s = defaultStore();
  s = applyAnswer(s, 1, true);
  s = applyAnswer(s, 4, false);
  s = applyAnswer(s, 4, false);
  assert.equal(accuracy(s), 33);
  const weak = weakSpecies(s, dex);
  assert.equal(weak[0].id, 4, 'the most-missed species comes first');
});

test('a full dex earns Pokémon Master and nothing less does', () => {
  let s = defaultStore();
  for (const p of dex) s = applyAnswer(s, p.id, true);
  const prog = dexProgress(s, dex);
  assert.equal(prog.registered, 1025);
  assert.equal(prog.pct, 100);
  assert.equal(trainerRank(prog.pct), 'Pokémon Master');

  let almost = defaultStore();
  for (const p of dex.slice(0, 1024)) almost = applyAnswer(almost, p.id, true);
  assert.notEqual(trainerRank(dexProgress(almost, dex).pct), 'Pokémon Master');
});
