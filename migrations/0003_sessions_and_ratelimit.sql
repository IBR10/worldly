-- Move session and rate-limit state off Workers KV, and re-key the XP
-- leaderboard from display name to a stable per-player id.
--
-- Why: Workers KV Free allows 1,000 writes/day and 1 write/second per key.
-- One Challenge run cost ~18 KV writes (1 rate-limit + 1 session on start,
-- 1 per answer, 1 for the XP sync), so the whole site supported roughly 55
-- Challenge runs per day before writes began failing. The per-key limit was
-- worse than the quota: the session row is rewritten on every answer, so a
-- player using the number-key shortcuts could exceed 1 write/second, get a
-- 429, and have the client score that question wrong with a "Connection
-- lost" toast -- penalising exactly the fast play Challenge mode rewards.
--
-- D1 Free allows 100,000 rows written/day with no per-key rate limit, which
-- takes the same workload to roughly 4,700 Challenge runs/day.

-- Server-graded Challenge/Daily sessions. `questions` holds the answers and
-- reveal copy that must never be sent to the client until it has answered.
CREATE TABLE session (
  id            TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('challenge', 'daily')),
  date          TEXT,
  questions     TEXT NOT NULL,
  answered      TEXT NOT NULL DEFAULT '{}',
  run_streak    INTEGER NOT NULL DEFAULT 0,
  running_score INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_session_expires ON session (expires_at);

-- Fixed-window per-IP counters. Incremented with a single
-- INSERT .. ON CONFLICT DO UPDATE .. RETURNING, which is atomic -- unlike the
-- previous KV read-then-write, where concurrent requests all read the same
-- value and all passed.
CREATE TABLE rate_limit (
  bucket_key TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limit_expires ON rate_limit (expires_at);

-- The old table used the display name as its primary key, and sanitizeName()
-- falls back to 'Explorer', so every player who never opened Profile shared a
-- single row -- the top entry was a merge of an unbounded number of anonymous
-- players. Combined with `xp = MAX(stored, submitted)` any inflated value was
-- also permanent. Renamed rather than dropped so nothing is destroyed.
ALTER TABLE xp_leaderboard RENAME TO xp_leaderboard_v1_by_name;
-- RENAME carries the old indexes across with their original names, so the name
-- has to be freed before it can be reused below. The archived table is not
-- queried, so it does not need one.
DROP INDEX IF EXISTS idx_xp_leaderboard_xp;

CREATE TABLE xp_leaderboard (
  player_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  xp         INTEGER NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_xp_leaderboard_xp ON xp_leaderboard (xp DESC) WHERE hidden = 0;
