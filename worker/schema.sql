CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  multi_submit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_authors (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);
CREATE INDEX IF NOT EXISTS proposal_authors_user ON proposal_authors(user_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);

CREATE TABLE IF NOT EXISTS votings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  winner_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  started_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_voting ON votings(status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS voting_options (
  voting_id INTEGER NOT NULL REFERENCES votings(id) ON DELETE CASCADE,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  PRIMARY KEY (voting_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS votes (
  voting_id INTEGER NOT NULL REFERENCES votings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  PRIMARY KEY (voting_id, user_id)
);
