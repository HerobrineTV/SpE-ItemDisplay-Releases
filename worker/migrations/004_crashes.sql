-- Crash reports of the game servers (SpE Lucky Battles uploads them with the RESULTS_TOKEN)
CREATE TABLE IF NOT EXISTS crashes (
  id TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  source TEXT NOT NULL,
  file_name TEXT NOT NULL,
  crashed_at INTEGER NOT NULL,
  description TEXT,
  cause TEXT,
  culprit TEXT,
  report TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crashes_crashed ON crashes(crashed_at);
