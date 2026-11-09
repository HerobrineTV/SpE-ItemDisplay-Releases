ALTER TABLE users ADD COLUMN multi_submit INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS proposal_authors (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);
CREATE INDEX IF NOT EXISTS proposal_authors_user ON proposal_authors(user_id, created_at);

INSERT OR IGNORE INTO proposal_authors (proposal_id, user_id, created_at)
  SELECT id, author_id, created_at FROM proposals;
