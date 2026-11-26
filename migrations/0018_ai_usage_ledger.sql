PRAGMA foreign_keys = ON;

-- Ledger of every Workers AI consumer: one row per agent run and one
-- aggregate row per knowledge-graph sync invocation. Token counts are exact
-- as reported by the model; neurons and USD are derived from the model's
-- published per-token prices ($0.011 per 1,000 neurons).
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'kg-sync')),
  key_id TEXT,
  model TEXT NOT NULL,
  prompt TEXT,
  identity TEXT,
  tool_calls INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  neurons REAL,
  cost_usd REAL,
  duration_ms INTEGER,
  -- 1 = reconstructed after the fact (tokens may be rounded or unknown)
  backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ai_runs_time ON ai_runs(created_at DESC);
CREATE INDEX ai_runs_kind_time ON ai_runs(kind, created_at DESC);
