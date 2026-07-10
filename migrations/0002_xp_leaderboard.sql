CREATE TABLE xp_leaderboard (
  name TEXT PRIMARY KEY,
  xp INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_xp_leaderboard_xp ON xp_leaderboard (xp DESC);
