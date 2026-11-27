PRAGMA foreign_keys = ON;

-- Retire the built-in mailbox agent and background knowledge graph so the
-- data plane stays pure D1 + R2 + Queues + Clef triage with zero per-message
-- trigger or Vectorize overhead.

DROP TRIGGER IF EXISTS kg_state_after_message_insert;
DROP TRIGGER IF EXISTS kg_state_after_message_ready;
DROP TRIGGER IF EXISTS kg_vector_delete_after_message_delete;

DROP TABLE IF EXISTS agent_chat_drafts;
DROP TABLE IF EXISTS agent_chat_messages;
DROP TABLE IF EXISTS agent_chats;

DROP TABLE IF EXISTS kg_edges;
DROP TABLE IF EXISTS kg_mentions;
DROP TABLE IF EXISTS kg_entities;
DROP TABLE IF EXISTS kg_state;
DROP TABLE IF EXISTS kg_vector_deletions;
DROP TABLE IF EXISTS message_gists;

-- Narrow ai_runs to active autopilot kinds only.
CREATE TABLE ai_runs_clean (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('spam', 'triage', 'draft', 'brief')),
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
  backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ai_runs_clean
SELECT * FROM ai_runs WHERE kind IN ('spam', 'triage', 'draft', 'brief');

DROP TABLE ai_runs;
ALTER TABLE ai_runs_clean RENAME TO ai_runs;

CREATE INDEX ai_runs_time ON ai_runs(created_at DESC);
CREATE INDEX ai_runs_kind_time ON ai_runs(kind, created_at DESC);

PRAGMA optimize;
