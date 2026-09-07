// pokestate.js — Pokédex progress, stored separately from the player profile.
//
// Deliberately NOT part of worldly_profile_v1. The Pokédex is a sandbox: it must
// never move world-knowledge XP, levels, streaks, achievements or the global
// leaderboard, and keeping the two stores apart is the cheapest way to guarantee
// that — there is no shared object for a bug to leak across.
//
// Storage is kept terse (single-letter keys, and only species actually
// encountered) because of the constraint documented at the top of sw.js: on iOS
// Safari a storage-quota blowout evicts the whole origin, including the
// localStorage that holds the player's only copy of their progress. A full dex
// at 1025 species costs roughly 25 KB in this shape.
//
// The reducers at the top are pure and take the store explicitly, so they test
// under plain `node --test` with no DOM. Only the wrapper at the bottom touches
// localStorage.

const KEY = 'worldly_pokedex_v1';

/** Correct answers needed to register a species, and to master it. */
export const REGISTER_AT = 1;
export const MASTER_AT = 3;

export function defaultStore() {
  return {
    v: 1,
    e: {},            // id -> { c: correct, w: wrong, s: current correct-streak }
    answered: 0,
    correct: 0,
    streak: 0,
    bestStreak: 0,
    lastPlayed: null,
  };
}

// ---- pure reducers -----------------------------------------------------------

/**
 * Record one answer and return the updated store.
 *
 * Mastery uses a *consecutive* streak that a miss resets to zero, so mastery
 * means current knowledge rather than a total that can never go down. The
 * registration itself is permanent: once you have identified a Pokémon you have
 * identified it, and taking that back would be punitive rather than instructive.
 */
export function applyAnswer(store, monId, correct) {
  const next = { ...store, e: { ...store.e } };
  next.answered += 1;
  if (correct) next.correct += 1;
  next.streak = correct ? next.streak + 1 : 0;
  next.bestStreak = Math.max(next.bestStreak, next.streak);

  if (monId != null) {
    const prev = next.e[monId] || { c: 0, w: 0, s: 0 };
    next.e[monId] = correct
      ? { c: prev.c + 1, w: prev.w, s: prev.s + 1 }
      : { c: prev.c, w: prev.w + 1, s: 0 };
  }
  return next;
}

export function isRegistered(store, id) {
  const rec = store.e[id];
  return !!rec && rec.c >= REGISTER_AT;
}

export function isMastered(store, id) {
  const rec = store.e[id];
  return !!rec && rec.s >= MASTER_AT;
}

/** Species answered wrong more often than right — the "keep practising" list. */
export function weakSpecies(store, dex, limit = 12) {
  return dex
    .filter((p) => {
      const rec = store.e[p.id];
      return rec && rec.w > 0;
    })
    .sort((a, b) => {
      const ra = store.e[a.id], rb = store.e[b.id];
      return (rb.w - rb.c) - (ra.w - ra.c) || rb.w - ra.w;
    })
    .slice(0, limit);
}

/** Overall and per-generation completion. */
export function dexProgress(store, dex) {
  const byGen = {};
  let registered = 0, mastered = 0;
  for (const p of dex) {
    const g = (byGen[p.gen] ||= { gen: p.gen, total: 0, registered: 0, mastered: 0 });
    g.total += 1;
    if (isRegistered(store, p.id)) { registered += 1; g.registered += 1; }
    if (isMastered(store, p.id)) { mastered += 1; g.mastered += 1; }
  }
  const total = dex.length;
  return {
    total,
    registered,
    mastered,
    pct: total ? Math.round((registered / total) * 1000) / 10 : 0,
    byGen: Object.values(byGen).sort((a, b) => a.gen - b.gen),
  };
}

export function accuracy(store) {
  return store.answered ? Math.round((store.correct / store.answered) * 100) : 0;
}

/**
 * Trainer rank from dex completion.
 *
 * This is the whole point of the feature: the rank is earned only by correctly
 * identifying Pokémon, so someone who has actually put the hours in ends up a
 * Pokémon Master and nobody can shortcut it.
 */
const RANKS = [
  [100, 'Pokémon Master'],
  [85, 'Champion'],
  [70, 'Elite Four'],
  [50, 'Gym Leader'],
  [30, 'Ace Trainer'],
  [15, 'Youngster'],
  [5, 'Bug Catcher'],
  [0, 'Rookie Trainer'],
];

export function trainerRank(pct) {
  return RANKS.find(([min]) => pct >= min)[1];
}

/** The next rank up and how far away it is, for the progress screen. */
export function nextRank(pct) {
  const higher = RANKS.filter(([min]) => min > pct);
  if (!higher.length) return null;
  const [min, title] = higher[higher.length - 1];
  return { title, at: min, remaining: Math.round((min - pct) * 10) / 10 };
}

// ---- persistence -------------------------------------------------------------

let store = null;

/**
 * Read the store. Unknown/older shapes are merged over the defaults, so a field
 * added later arrives with a sane value and needs no migration code.
 */
export function loadPoke() {
  try {
    const raw = localStorage.getItem(KEY);
    store = raw ? { ...defaultStore(), ...JSON.parse(raw) } : defaultStore();
  } catch {
    store = defaultStore();
  }
  return store;
}

export function getPoke() {
  return store || loadPoke();
}

export function savePoke() {
  try {
    localStorage.setItem(KEY, JSON.stringify(getPoke()));
    return true;
  } catch {
    // Same contract as state.js: tell the app rather than failing silently, so
    // it can warn that progress is not being kept.
    window.dispatchEvent(new CustomEvent('worldly:save-failed'));
    return false;
  }
}

/** Record an answer against the live store and persist it. */
export function recordPokeAnswer(monId, correct) {
  const before = getPoke();
  const wasRegistered = monId != null && isRegistered(before, monId);
  const wasMastered = monId != null && isMastered(before, monId);
  store = applyAnswer(before, monId, correct);
  savePoke();
  return {
    newlyRegistered: monId != null && !wasRegistered && isRegistered(store, monId),
    newlyMastered: monId != null && !wasMastered && isMastered(store, monId),
  };
}

export function resetPokedex() {
  store = defaultStore();
  savePoke();
  return store;
}

export function exportPokedex() {
  return getPoke();
}

export function importPokedex(parsed) {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.e !== 'object') return false;
  store = { ...defaultStore(), ...parsed };
  return savePoke();
}
