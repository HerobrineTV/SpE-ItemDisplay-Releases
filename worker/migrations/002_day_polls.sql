ALTER TABLE events ADD COLUMN start_time TEXT;

CREATE TABLE IF NOT EXISTS day_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  chosen_start INTEGER,
  started_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_day_poll ON day_polls(date) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS day_poll_responses (
  poll_id INTEGER NOT NULL REFERENCES day_polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  available INTEGER NOT NULL,
  start_min INTEGER,
  end_min INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
