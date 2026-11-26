PRAGMA foreign_keys = ON;

-- Every inbound message is classified once by a small Workers AI model. Spam
-- is kept — nothing is deleted or rejected — it is only hidden: the mailbox
-- listings and the inbox counters skip spam = 1, and a dedicated 'spam'
-- virtual folder is the one place it shows up again.
ALTER TABLE messages ADD COLUMN spam INTEGER NOT NULL DEFAULT 0 CHECK (spam IN (0, 1));
-- Which model produced the verdict, and when. NULL means never classified
-- (mail that predates this migration, or a classifier failure — both of which
-- deliberately fall through as not-spam).
ALTER TABLE messages ADD COLUMN spam_model TEXT;
ALTER TABLE messages ADD COLUMN spam_checked_at TEXT;

CREATE INDEX messages_identity_spam_time_idx
  ON messages(identity_address, received_at DESC, id DESC)
  WHERE status = 'ready' AND spam = 1;

ALTER TABLE mailbox_counts ADD COLUMN spam INTEGER NOT NULL DEFAULT 0 CHECK (spam >= 0);

-- The classifier is a third consumer of Workers AI, so the ledger's kind check
-- has to grow. SQLite cannot alter a CHECK constraint in place; the table is
-- small and append-only, so it is rebuilt.
CREATE TABLE ai_runs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'kg-sync', 'spam')),
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
INSERT INTO ai_runs_new SELECT * FROM ai_runs;
DROP TABLE ai_runs;
ALTER TABLE ai_runs_new RENAME TO ai_runs;
CREATE INDEX ai_runs_time ON ai_runs(created_at DESC);
CREATE INDEX ai_runs_kind_time ON ai_runs(kind, created_at DESC);

-- Counter triggers, restated so that inbox and unread ignore spam and the new
-- spam counter tracks it instead. Everything else is 0013's version verbatim.
DROP TRIGGER mailbox_counts_messages_after_insert;
CREATE TRIGGER mailbox_counts_messages_after_insert
AFTER INSERT ON messages
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash, spam)
  SELECT NEW.identity_address,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.spam = 0 AND NEW.unread = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.spam = 0 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'sent' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.starred = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'archive' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.spam = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET
    unread = unread + excluded.unread, inbox = inbox + excluded.inbox,
    sent = sent + excluded.sent, starred = starred + excluded.starred,
    archive = archive + excluded.archive, trash = trash + excluded.trash,
    spam = spam + excluded.spam,
    updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER mailbox_counts_messages_after_delete;
CREATE TRIGGER mailbox_counts_messages_after_delete
AFTER DELETE ON messages
WHEN OLD.identity_address IS NOT NULL
BEGIN
  UPDATE mailbox_counts SET
    unread = unread - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.spam = 0 AND OLD.unread = 1 THEN 1 ELSE 0 END,
    inbox = inbox - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.spam = 0 THEN 1 ELSE 0 END,
    sent = sent - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'sent' THEN 1 ELSE 0 END,
    starred = starred - CASE WHEN OLD.status = 'ready' AND OLD.starred = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    archive = archive - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'archive' THEN 1 ELSE 0 END,
    trash = trash - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'trash' THEN 1 ELSE 0 END,
    spam = spam - CASE WHEN OLD.status = 'ready' AND OLD.spam = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;
END;

DROP TRIGGER mailbox_counts_messages_after_update;
CREATE TRIGGER mailbox_counts_messages_after_update
AFTER UPDATE OF identity_address, status, folder, unread, starred, spam ON messages
WHEN OLD.identity_address IS NOT NEW.identity_address
  OR OLD.status IS NOT NEW.status
  OR OLD.folder IS NOT NEW.folder
  OR OLD.unread IS NOT NEW.unread
  OR OLD.starred IS NOT NEW.starred
  OR OLD.spam IS NOT NEW.spam
BEGIN
  UPDATE mailbox_counts SET
    unread = unread - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.spam = 0 AND OLD.unread = 1 THEN 1 ELSE 0 END,
    inbox = inbox - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.spam = 0 THEN 1 ELSE 0 END,
    sent = sent - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'sent' THEN 1 ELSE 0 END,
    starred = starred - CASE WHEN OLD.status = 'ready' AND OLD.starred = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    archive = archive - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'archive' THEN 1 ELSE 0 END,
    trash = trash - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'trash' THEN 1 ELSE 0 END,
    spam = spam - CASE WHEN OLD.status = 'ready' AND OLD.spam = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;

  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash, spam)
  SELECT NEW.identity_address,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.spam = 0 AND NEW.unread = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.spam = 0 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'sent' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.starred = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'archive' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.spam = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END
  WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET
    unread = unread + excluded.unread, inbox = inbox + excluded.inbox,
    sent = sent + excluded.sent, starred = starred + excluded.starred,
    archive = archive + excluded.archive, trash = trash + excluded.trash,
    spam = spam + excluded.spam,
    updated_at = CURRENT_TIMESTAMP;
END;

-- Rebuilding an identity's counters happens on re-enable; teach it the same
-- spam-aware definitions.
DROP TRIGGER mailbox_counts_identities_after_insert;
CREATE TRIGGER mailbox_counts_identities_after_insert
AFTER INSERT ON identities
BEGIN
  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash, drafts, spam)
  SELECT NEW.address,
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'inbox' AND m.spam = 0 AND m.unread = 1 THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'inbox' AND m.spam = 0 THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'sent' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.starred = 1 AND m.folder != 'trash' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'archive' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'trash' THEN 1 ELSE 0 END), 0),
    (SELECT COUNT(*) FROM drafts d WHERE d.identity_address = NEW.address),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.spam = 1 AND m.folder != 'trash' THEN 1 ELSE 0 END), 0)
  FROM (SELECT 1) seed
  LEFT JOIN messages m ON m.identity_address = NEW.address
  WHERE 1 = 1
  ON CONFLICT(identity_address) DO NOTHING;

  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.address, 1)
  ON CONFLICT(identity_address) DO NOTHING;
END;

-- The push outbox is filled by trigger, so the spam verdict has to be part of
-- that condition too — otherwise the phone announces mail the mailbox hides.
DROP TRIGGER push_outbox_messages_after_insert;
CREATE TRIGGER push_outbox_messages_after_insert
AFTER INSERT ON messages
WHEN NEW.direction = 'inbound' AND NEW.status = 'ready' AND NEW.spam = 0 AND NEW.identity_address IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO push_notification_outbox (message_id, identity_address)
  VALUES (NEW.id, NEW.identity_address);
END;

DROP TRIGGER push_outbox_messages_after_ready;
CREATE TRIGGER push_outbox_messages_after_ready
AFTER UPDATE OF status ON messages
WHEN NEW.direction = 'inbound' AND NEW.status = 'ready' AND OLD.status IS NOT 'ready'
  AND NEW.spam = 0 AND NEW.identity_address IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO push_notification_outbox (message_id, identity_address)
  VALUES (NEW.id, NEW.identity_address);
END;

PRAGMA optimize;
