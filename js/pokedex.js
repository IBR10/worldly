// pokedex.js — the pure question engine for the Pokédex practice modes.
//
// No DOM, no fetch, so this runs under plain `node --test` exactly like
// quiz.js / maps.js / srs.js. Rendering lives in pokedexview.js.
//
// Why this is a parallel engine rather than new entries in quiz.js's MODES:
// functions/api/session/start.js imports quiz.js and the country datasets
// directly to build server-side Challenge/Daily sessions. Threading Pokémon
// through MODES would drag a 460 KB dataset into that Cloudflare Function and
// risk Pokémon leaking into Mixed/Challenge/Daily, which are meant to stay
// world-knowledge. Keeping the two engines side by side is what makes the
// Pokédex a genuinely separate sandbox.
//
// The generic sampling helpers are imported from quiz.js rather than
// reimplemented, so both engines shuffle, sample and no-repeat identically.

import { shuffle, sampleDistinct, drawWithoutRepeat, answerMatches } from './quiz.js';

export { answerMatches };

/**
 * The practice modes.
 *
 * `needs` filters the pool to species a mode can actually ask about (you cannot
 * ask what Pikachu evolves into if it has no evolution recorded). `registers`
 * marks the modes whose correct answer identifies one specific species, and so
 * counts toward Pokédex registration — a type-matchup question is about types,
 * not about any one Pokémon, so it teaches but does not register.
 */
export const POKE_MODES = {
  poke_who: {
    label: "Who's That Pokémon?",
    desc: 'Name it from its silhouette.',
    icon: 'help',
    registers: true,
  },
  poke_type: {
    label: 'Pokémon → Type',
    desc: 'Give its typing.',
    icon: 'flame',
    registers: true,
  },
  poke_dex: {
    label: 'Pokédex Entry',
    desc: 'Name it from its dex description.',
    icon: 'book',
    registers: true,
    needs: (p) => p.dex && p.dex.length > 20,
  },
  poke_gen: {
    label: 'Pokémon → Generation',
    desc: 'Which generation did it debut in?',
    icon: 'gamepad',
    registers: true,
  },
  poke_evo: {
    label: 'Evolution',
    desc: 'What does it evolve into?',
    icon: 'sprout',
    registers: true,
    needs: (p) => p.evolvesTo && p.evolvesTo.length > 0,
  },
  poke_stat: {
    label: 'Base Stats',
    desc: 'Which one has the highest stat?',
    icon: 'gauge',
    registers: true,
  },
  poke_matchup: {
    label: 'Type Matchups',
    desc: 'What beats what.',
    icon: 'swords',
    registers: false,
  },
};

export const ALL_POKE_MODES = Object.keys(POKE_MODES);

export const GENERATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Region each generation debuted in — labels only, used in prompts and filters. */
export const GEN_REGION = {
  1: 'Kanto', 2: 'Johto', 3: 'Hoenn', 4: 'Sinnoh', 5: 'Unova',
  6: 'Kalos', 7: 'Alola', 8: 'Galar', 9: 'Paldea',
};

export const STAT_LABELS = {
  hp: 'HP', atk: 'Attack', def: 'Defense',
  spa: 'Sp. Attack', spd: 'Sp. Defense', spe: 'Speed',
};

// ---- helpers -----------------------------------------------------------------

/** "electric" -> "Electric" */
export function typeLabel(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A species' typing as one display string: "Grass / Poison". */
export function typingOf(p) {
  return p.types.map(typeLabel).join(' / ');
}

/**
 * Damage multiplier of one attacking type against a defender's full typing.
 *
 * Multiplies the per-type factors, which is how the games stack a dual typing:
 * Electric into Water/Flying is 2 x 2 = 4, Electric into Ground/Rock is 0 x 1 = 0.
 */
export function typeEffectiveness(chart, attackType, defenderTypes) {
  const row = chart[attackType];
  if (!row) return 1;
  return defenderTypes.reduce((mult, d) => mult * (row[d] === undefined ? 1 : row[d]), 1);
}

/**
 * Distractor species for a question about `target`.
 *
 * Tiered like quiz.js's geoDistractors: same generation first, then anything
 * sharing a type, then the whole dex. A Gen 1 question whose three wrong answers
 * are all obscure Gen 9 species is guessable without knowing anything, so
 * plausible neighbours are what make the mode actually test recall.
 */
export function pokeDistractors(dex, target, n, rng = Math.random) {
  const tiers = [
    dex.filter((p) => p.id !== target.id && p.gen === target.gen),
    dex.filter((p) => p.id !== target.id && p.types.some((t) => target.types.includes(t))),
    dex.filter((p) => p.id !== target.id),
  ];
  const chosen = [];
  const seen = new Set([target.id]);
  for (const tier of tiers) {
    if (chosen.length >= n) break;
    for (const p of shuffle(tier, rng)) {
      if (chosen.length >= n) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      chosen.push(p);
    }
  }
  return chosen;
}

/**
 * Hide the species' own name inside its dex entry.
 *
 * Without this the "name it from its description" mode gives itself away: a
 * good third of entries say the name outright. Matching is case-insensitive
 * because older entries shout it in capitals.
 */
export function redactName(text, name) {
  if (!text) return '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), '?????');
}

// ---- pool --------------------------------------------------------------------

/**
 * Build the question pool.
 *
 * One entry per (mode, species) pair that the mode can ask about. Pool item ids
 * are `mode:id` so drawWithoutRepeat can keep a session from asking the same
 * question twice while still allowing the same species under a different mode.
 */
export function buildPokePool(dex, { modes = ALL_POKE_MODES, gens = 'all', types = 'all' } = {}) {
  const genOk = gens === 'all' ? () => true : (p) => gens.includes(p.gen);
  const typeOk = types === 'all' ? () => true : (p) => p.types.some((t) => types.includes(t));
  const eligible = dex.filter((p) => genOk(p) && typeOk(p));

  const pool = [];
  for (const mode of modes) {
    const def = POKE_MODES[mode];
    if (!def) continue;
    for (const p of eligible) {
      if (def.needs && !def.needs(p)) continue;
      pool.push({ id: `${mode}:${p.id}`, mode, mon: p });
    }
  }
  return pool;
}

// ---- questions ---------------------------------------------------------------

function wikiFor(name) {
  return `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}_(Pok%C3%A9mon)`;
}

function learnMore(p) {
  return [
    { label: 'Bulbapedia', url: wikiFor(p.name) },
    { label: 'PokéAPI', url: `https://pokeapi.co/api/v2/pokemon/${p.id}` },
  ];
}

/**
 * Turn one pool item into a rendered question.
 *
 * The returned shape is deliberately flat and view-agnostic:
 *   { id, mode, monId, prompt, sprite, silhouette, body, choices, answer, learnMore }
 * `monId` is the species whose registration this question can earn — null for
 * modes that aren't about a specific Pokémon.
 */
export function makePokeQuestion(item, dex, chart, { choices = 4, rng = Math.random } = {}) {
  const p = item.mon;
  const base = { id: item.id, mode: item.mode, monId: p ? p.id : null, learnMore: p ? learnMore(p) : [] };
  const nDistract = choices - 1;

  switch (item.mode) {
    case 'poke_who': {
      const wrong = pokeDistractors(dex, p, nDistract, rng).map((x) => x.name);
      return {
        ...base,
        prompt: "Who's that Pokémon?",
        sprite: p.id,
        silhouette: true,
        choices: shuffle([p.name, ...wrong], rng),
        answer: p.name,
      };
    }

    case 'poke_type': {
      const answer = typingOf(p);
      const wrong = sampleDistinct(
        pokeDistractors(dex, p, nDistract * 4, rng).map(typingOf),
        answer,
        nDistract,
        rng,
      );
      return {
        ...base,
        prompt: `What type is ${p.name}?`,
        sprite: p.id,
        silhouette: false,
        choices: shuffle([answer, ...wrong], rng),
        answer,
      };
    }

    case 'poke_dex': {
      const wrong = pokeDistractors(dex, p, nDistract, rng).map((x) => x.name);
      return {
        ...base,
        prompt: 'Which Pokémon does this Pokédex entry describe?',
        sprite: null,
        silhouette: false,
        body: redactName(p.dex, p.name),
        choices: shuffle([p.name, ...wrong], rng),
        answer: p.name,
      };
    }

    case 'poke_gen': {
      const answer = `Generation ${p.gen} (${GEN_REGION[p.gen]})`;
      const wrong = sampleDistinct(
        GENERATIONS.map((g) => `Generation ${g} (${GEN_REGION[g]})`),
        answer,
        nDistract,
        rng,
      );
      return {
        ...base,
        prompt: `Which generation did ${p.name} debut in?`,
        sprite: p.id,
        silhouette: false,
        choices: shuffle([answer, ...wrong], rng),
        answer,
      };
    }

    case 'poke_evo': {
      const answer = p.evolvesTo[0];
      const wrong = sampleDistinct(
        pokeDistractors(dex, p, nDistract * 3, rng).map((x) => x.name),
        answer,
        nDistract,
        rng,
      );
      return {
        ...base,
        prompt: `What does ${p.name} evolve into?`,
        sprite: p.id,
        silhouette: false,
        choices: shuffle([answer, ...wrong], rng),
        answer,
      };
    }

    case 'poke_stat': {
      // Pick the stat first, then a field of candidates, then ask which tops it.
      // Ties are excluded rather than resolved: two right answers is a broken
      // question, and with 1025 species there is always another field to draw.
      const statKeys = Object.keys(STAT_LABELS);
      const stat = statKeys[Math.floor(rng() * statKeys.length)];
      const field = [p, ...pokeDistractors(dex, p, nDistract, rng)];
      const best = field.reduce((a, b) => (b.stats[stat] > a.stats[stat] ? b : a));
      const tied = field.filter((x) => x.stats[stat] === best.stats[stat]);
      if (tied.length > 1) {
        // Fall back to a mode that cannot tie rather than emit an ambiguous one.
        return makePokeQuestion({ ...item, mode: 'poke_who' }, dex, chart, { choices, rng });
      }
      return {
        ...base,
        monId: best.id,
        learnMore: learnMore(best),
        prompt: `Which of these has the highest base ${STAT_LABELS[stat]}?`,
        sprite: null,
        silhouette: false,
        choices: shuffle(field.map((x) => x.name), rng),
        answer: best.name,
      };
    }

    case 'poke_matchup': {
      const defender = p;
      const types = Object.keys(chart);
      const strong = types.filter((t) => typeEffectiveness(chart, t, defender.types) > 1);
      const weak = types.filter((t) => typeEffectiveness(chart, t, defender.types) <= 1);
      if (!strong.length || weak.length < nDistract) {
        // Shedinja-likes and a few dual typings have no super-effective answer.
        return makePokeQuestion({ ...item, mode: 'poke_type' }, dex, chart, { choices, rng });
      }
      const answer = typeLabel(strong[Math.floor(rng() * strong.length)]);
      const wrong = shuffle(weak, rng).slice(0, nDistract).map(typeLabel);
      return {
        ...base,
        monId: null,
        prompt: `Which type is super effective against ${defender.name} (${typingOf(defender)})?`,
        sprite: defender.id,
        silhouette: false,
        choices: shuffle([answer, ...wrong], rng),
        answer,
      };
    }

    default:
      return null;
  }
}

// ---- session -----------------------------------------------------------------

/**
 * A stateful practice session.
 *
 * Mirrors quiz.js's createQuiz — same no-repeat sampling, same `next()` contract
 * — so the two engines behave identically from a player's point of view.
 */
export function createPokeQuiz({ dex, chart, config = {}, pick = null, rng = Math.random }) {
  const pool = buildPokePool(dex, config);
  const state = { asked: new Set(), lastId: null };
  return {
    size: pool.length,
    next() {
      const item = drawWithoutRepeat(pool, state, { pick, rng });
      if (!item) return null;
      return makePokeQuestion(item, dex, chart, { ...config, rng });
    },
  };
}
