PRAGMA foreign_keys = ON;

-- Work queue for the mail knowledge graph. Rows are created by triggers, so
-- every path that produces a ready message (inbound, external sync, outbound
-- send) is indexed without any code needing to remember to do so.
CREATE TABLE kg_state (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embed_status TEXT NOT NULL DEFAULT 'pending' CHECK (embed_status IN ('pending', 'done', 'failed')),
  extract_status TEXT NOT NULL DEFAULT 'pending' CHECK (extract_status IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX kg_state_pending ON kg_state(embed_status, extract_status, attempts);

CREATE TABLE message_gists (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  gist TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE kg_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (name, kind)
);

CREATE INDEX kg_entities_name ON kg_entities(name);

CREATE TABLE kg_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, entity_id)
);

CREATE INDEX kg_mentions_entity ON kg_mentions(entity_id);

CREATE TABLE kg_edges (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  subject_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  object_entity_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX kg_edges_subject ON kg_edges(subject_entity_id);
CREATE INDEX kg_edges_object ON kg_edges(object_entity_id);
CREATE INDEX kg_edges_message ON kg_edges(message_id);

-- Vectorize deletions happen over the network, so a trigger queues them here
-- and the sync loop drains the queue; graph rows cascade with the message.
CREATE TABLE kg_vector_deletions (
  message_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER kg_state_after_message_insert
AFTER INSERT ON messages
WHEN NEW.status = 'ready'
BEGIN
  INSERT OR IGNORE INTO kg_state (message_id) VALUES (NEW.id);
END;

CREATE TRIGGER kg_state_after_message_ready
AFTER UPDATE OF status ON messages
WHEN NEW.status = 'ready' AND OLD.status IS NOT 'ready'
BEGIN
  INSERT OR IGNORE INTO kg_state (message_id) VALUES (NEW.id);
END;

CREATE TRIGGER kg_vector_delete_after_message_delete
AFTER DELETE ON messages
BEGIN
  INSERT OR IGNORE INTO kg_vector_deletions (message_id) VALUES (OLD.id);
END;

-- Seed the queue with the existing mailbox; the scheduled sync drains it.
INSERT OR IGNORE INTO kg_state (message_id)
SELECT id FROM messages WHERE status = 'ready';
