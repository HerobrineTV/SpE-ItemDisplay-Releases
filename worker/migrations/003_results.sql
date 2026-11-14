CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  play_seconds INTEGER NOT NULL,
  modes TEXT NOT NULL,
  outcome TEXT,
  data TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_started ON results(started_at);

CREATE TABLE IF NOT EXISTS result_players (
  result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  place INTEGER,
  won INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (result_id, uuid)
);
CREATE INDEX IF NOT EXISTS result_players_uuid ON result_players(uuid);
