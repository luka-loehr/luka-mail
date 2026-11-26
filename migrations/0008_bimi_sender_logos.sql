PRAGMA foreign_keys = ON;

ALTER TABLE messages ADD COLUMN sender_authenticated INTEGER CHECK (sender_authenticated IN (0, 1));

CREATE TABLE sender_logos (
  domain TEXT PRIMARY KEY,
  object_key TEXT,
  source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('found', 'missing')),
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sender_logos_checked_idx ON sender_logos(checked_at);
