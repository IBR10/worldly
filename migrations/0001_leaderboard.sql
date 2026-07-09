CREATE TABLE leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('challenge', 'daily')),
  score INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leaderboard_mode_score ON leaderboard (mode, score DESC);
CREATE INDEX idx_leaderboard_mode_date ON leaderboard (mode, date, score DESC);
