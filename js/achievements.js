// achievements.js — evaluates achievement definitions against the live profile.
//
// Each definition (see data/achievements.json) has a `type` that maps to a
// progress value computed from the profile. `checkAchievements` returns any
// achievements newly unlocked by the most recent activity so the UI can toast
// them.

import { getData } from './data.js';
import { levelFromXp } from './state.js';

/** Compute current progress toward a single achievement definition. */
export function progressFor(def, profile) {
  switch (def.type) {
    case 'totalAnswered':
      return profile.totalAnswered;
    case 'xp':
      return profile.xp;
    case 'bestStreak':
      return profile.bestStreak;
    case 'perfectQuiz':
      return profile.perfectQuizzes;
    case 'dailyCompleted':
      return profile.dailyCompleted;
    case 'categoryCorrect':
      return profile.perCategory[def.category]?.correct || 0;
    case 'regionCorrect':
      return profile.perRegion[def.region]?.correct || 0;
    default:
      return 0;
  }
}

/**
 * Unlock any achievements whose threshold is now met. Mutates profile.achievements.
 * @returns {Array} the achievement definitions newly unlocked this call.
 */
export function checkAchievements(profile) {
  const defs = getData().achievements;
  const newly = [];
  for (const def of defs) {
    if (profile.achievements[def.id]) continue;
    if (progressFor(def, profile) >= def.threshold) {
      profile.achievements[def.id] = new Date().toISOString();
      newly.push(def);
    }
  }
  return newly;
}

/** A view-model list of all achievements with unlocked flag + progress %. */
export function achievementStatus(profile) {
  const defs = getData().achievements;
  return defs.map((def) => {
    const cur = progressFor(def, profile);
    return {
      ...def,
      unlocked: Boolean(profile.achievements[def.id]),
      current: Math.min(cur, def.threshold),
      pct: Math.min(100, Math.round((cur / def.threshold) * 100)),
    };
  });
}

export function levelTitle(xp) {
  const titles = ['Novice', 'Wanderer', 'Tourist', 'Traveler', 'Navigator', 'Cartographer', 'Globetrotter', 'Geography Wizard'];
  const lvl = levelFromXp(xp);
  return titles[Math.min(lvl - 1, titles.length - 1)];
}
