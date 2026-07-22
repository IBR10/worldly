// state.js — the player's profile, persisted to localStorage.
// This is the single source of truth for progress: XP, streaks, per-category and
// per-region accuracy, the spaced-repetition boxes, the "missed" review pool,
// unlocked achievements, theme and the local leaderboard.

const STORAGE_KEY = 'worldly_profile_v1';
// Prior key (the app was called "GeoGenius"). Read once so existing players keep
// all their XP, streaks and achievements after the rename to Worldly.
const LEGACY_STORAGE_KEY = 'geogenius_profile_v1';

/** Opaque per-player id for the XP leaderboard. Keying that board on the
 *  display name merged every player who never set one into a single
 *  'Explorer' row. Generated once and carried through export/import so a
 *  transferred profile keeps its leaderboard entry rather than forking it. */
function newPlayerId() {
  try {
    return crypto.randomUUID();
  } catch {
    // randomUUID needs a secure context; fall back so file:// / http:// still work.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

const DEFAULT_PROFILE = () => ({
  version: 1,
  playerId: newPlayerId(),
  name: 'Explorer',
  xp: 0,
  bestStreak: 0,
  currentStreak: 0,
  totalAnswered: 0,
  totalCorrect: 0,
  studyTimeMs: 0,
  perfectQuizzes: 0,
  dailyCompleted: 0,
  lastDaily: null, // 'YYYY-MM-DD'
  perCategory: {}, // cat -> { answered, correct }
  perRegion: {}, // region -> { answered, correct }
  srs: {}, // itemId -> { box, correct, wrong, lastSeen }
  missed: {}, // itemId -> { category, region, label, answer, wrong, lastWrong }
  achievements: {}, // id -> ISO timestamp unlocked
  leaderboard: [], // { score, mode, date }
  // null = follow the OS. Existing profiles keep whatever they stored, so this
  // only changes what a first-time visitor sees.
  theme: null,
  onboarded: false, // first-visit explainer dismissed
});

/** Today as YYYY-MM-DD in the player's LOCAL timezone (daily-challenge day). */
export function localDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // en-CA formats as YYYY-MM-DD
}

let profile = DEFAULT_PROFILE();

export function loadProfile() {
  try {
    // Fall back to the legacy GeoGenius key so progress survives the rename;
    // once loaded we persist under the new key (below).
    let raw = localStorage.getItem(STORAGE_KEY);
    let migrated = false;
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      migrated = !!raw;
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      profile = { ...DEFAULT_PROFILE(), ...parsed };
      // Profiles saved before playerId existed spread a `undefined` over the
      // generated default; mint one and persist so it stays stable afterwards.
      if (!profile.playerId) {
        profile.playerId = newPlayerId();
        migrated = true;
      }
      if (migrated) saveProfile(); // copy old progress under the Worldly key
    }
  } catch (e) {
    console.warn('Could not read saved profile, starting fresh.', e);
    profile = DEFAULT_PROFILE();
  }
  return profile;
}

export function getProfile() {
  return profile;
}

export function saveProfile() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (e) {
    console.warn('Could not persist profile.', e);
    // Let the UI surface this (quota full / private mode) instead of losing
    // progress silently. Guarded so the pure-Node test runner never sees it.
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('worldly:save-failed'));
    }
  }
}

export function setOnboarded() {
  profile.onboarded = true;
  saveProfile();
}

/**
 * Replace the profile with an imported one (device transfer / backup restore).
 * Unknown fields are dropped by the spread-over-defaults merge; missing fields
 * get defaults, so files from older versions keep working.
 */
export function importProfile(parsed) {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.xp !== 'number' || typeof parsed.srs !== 'object') {
    throw new Error("That file doesn't look like a Worldly profile export.");
  }
  profile = { ...DEFAULT_PROFILE(), ...parsed };
  if (!profile.playerId) profile.playerId = newPlayerId(); // pre-playerId export
  saveProfile();
  return profile;
}

export function resetProfile() {
  const { theme, playerId } = profile;
  profile = DEFAULT_PROFILE();
  profile.theme = theme;
  // Same device, same person: minting a new id would orphan the old
  // leaderboard row (which can never be lowered) and grow the table forever.
  profile.playerId = playerId || profile.playerId;
  saveProfile();
  return profile;
}

// ---- XP / level math ---------------------------------------------------------
// Levels follow a gentle quadratic curve so early levels come fast and later
// ones take longer. xpForLevel(n) is the cumulative XP needed to reach level n.
export function xpForLevel(level) {
  return Math.round(50 * (level - 1) * level); // L1=0, L2=100, L3=300, L4=600...
}

export function levelFromXp(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}

export function levelProgress(xp) {
  const level = levelFromXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const into = xp - base;
  const span = next - base;
  return { level, into, span, pct: span ? Math.round((into / span) * 100) : 0, next };
}

// ---- Recording answers -------------------------------------------------------

function bump(map, key) {
  if (!map[key]) map[key] = { answered: 0, correct: 0 };
  return map[key];
}

/**
 * Record the outcome of one answered question and return a small summary
 * (xp gained, new level, whether the player levelled up).
 * @param {object} q      the question object from quiz.js
 * @param {boolean} correct
 * @param {object} opts   { multiplier }
 */
export function recordAnswer(q, correct, opts = {}) {
  const multiplier = opts.multiplier || 1;
  const beforeLevel = levelFromXp(profile.xp);

  profile.totalAnswered += 1;
  const cat = bump(profile.perCategory, q.category);
  cat.answered += 1;
  if (q.region) {
    const reg = bump(profile.perRegion, q.region);
    reg.answered += 1;
    if (correct) reg.correct += 1;
  }

  // Spaced repetition (Leitner) box update.
  const srs = profile.srs[q.id] || { box: 0, correct: 0, wrong: 0, lastSeen: 0 };
  srs.lastSeen = Date.now();

  let xpGained = 0;
  if (correct) {
    profile.totalCorrect += 1;
    cat.correct += 1;
    profile.currentStreak += 1;
    profile.bestStreak = Math.max(profile.bestStreak, profile.currentStreak);
    srs.correct += 1;
    srs.box = Math.min(5, srs.box + 1);
    // base 10 xp, +streak bonus up to +10, times any challenge multiplier
    const streakBonus = Math.min(10, Math.floor(profile.currentStreak / 2));
    xpGained = Math.round((10 + streakBonus) * multiplier);
    profile.xp += xpGained;
    // Leave the review pool once the item has been re-learned (box >= 2).
    if (profile.missed[q.id] && srs.box >= 2) delete profile.missed[q.id];
  } else {
    profile.currentStreak = 0;
    srs.wrong += 1;
    srs.box = Math.max(0, srs.box - 1);
    profile.missed[q.id] = {
      category: q.category,
      region: q.region || null,
      label: q.prompt,
      answer: q.answer,
      wrong: (profile.missed[q.id]?.wrong || 0) + 1,
      lastWrong: Date.now(),
    };
  }

  profile.srs[q.id] = srs;
  saveProfile();

  const afterLevel = levelFromXp(profile.xp);
  return { xpGained, level: afterLevel, levelledUp: afterLevel > beforeLevel };
}

export function recordStudyTime(ms) {
  profile.studyTimeMs += ms;
  saveProfile();
}

export function recordPerfectQuiz() {
  profile.perfectQuizzes += 1;
  saveProfile();
}

/** Mark today's daily challenge complete (only counts once per calendar day). */
export function markDailyComplete(score) {
  const today = localDateStr();
  if (profile.lastDaily !== today) {
    profile.lastDaily = today;
    profile.dailyCompleted += 1;
  }
  addLeaderboard(score, 'Daily');
  saveProfile();
}

export function dailyDoneToday() {
  return profile.lastDaily === localDateStr();
}

export function addLeaderboard(score, mode) {
  profile.leaderboard.push({ score, mode, date: new Date().toISOString() });
  profile.leaderboard.sort((a, b) => b.score - a.score);
  profile.leaderboard = profile.leaderboard.slice(0, 10);
  saveProfile();
}

export function setTheme(theme) {
  profile.theme = theme;
  saveProfile();
}

export function setName(name) {
  profile.name = (name || '').trim().slice(0, 20) || 'Explorer';
  saveProfile();
}

/** Overall accuracy as a 0-100 integer. */
export function accuracy() {
  return profile.totalAnswered
    ? Math.round((profile.totalCorrect / profile.totalAnswered) * 100)
    : 0;
}
