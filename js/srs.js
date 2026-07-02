// srs.js — spaced-repetition selection helpers.
//
// We use a lightweight Leitner-style scheme. Every quizzable item lives in a
// "box" from 0 (just missed / brand new) to 5 (well known). Lower boxes are due
// more often. `weightFor` turns an item's history into a sampling weight so the
// quiz engine can draw harder/forgotten items more frequently while still
// occasionally refreshing mastered ones. These functions are pure (no globals,
// no DOM) so they can be unit-tested directly under Node.

// How long (ms) an item in each box is considered "resting" before it is due
// again. Box 0 is always due; higher boxes rest longer (1h, 6h, 1d, 3d, 7d).
const BOX_INTERVAL_MS = [0, 36e5, 216e5, 864e5, 2592e5, 6048e5];

/** Sampling weight for one item given its SRS record (or undefined if new). */
export function weightFor(itemId, srsMap, now = Date.now()) {
  const rec = srsMap[itemId];
  if (!rec) return 3; // never seen — solid baseline so coverage stays good
  const interval = BOX_INTERVAL_MS[Math.min(rec.box, 5)] ?? 0;
  const due = now - rec.lastSeen >= interval;
  // Forgotten/low-box items get heavy weight; mastered, not-yet-due items get a
  // small trickle so they are still occasionally reviewed.
  const base = Math.max(1, 7 - rec.box);
  const missBoost = 1 + Math.min(4, rec.wrong); // each past miss raises priority
  return due ? base * missBoost : 0.5;
}

/**
 * Pick one element from `pool` weighted by SRS priority.
 * @param {Array} pool        candidate items (each must expose an `id`)
 * @param {object} srsMap     itemId -> srs record
 * @param {() => number} rng  random source in [0,1) (injectable for tests)
 */
export function pickWeighted(pool, srsMap, rng = Math.random, now = Date.now()) {
  if (pool.length === 0) return null;
  const weights = pool.map((item) => weightFor(item.id, srsMap, now));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return pool[Math.floor(rng() * pool.length)];
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Count of items currently considered "weak" (missed at least once, box < 2). */
export function weakCount(srsMap) {
  return Object.values(srsMap).filter((r) => r.wrong > 0 && r.box < 2).length;
}
