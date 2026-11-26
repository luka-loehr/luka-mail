PRAGMA foreign_keys = ON;

-- Keep mailbox badges constant-time. These values are derived entirely from
-- messages and drafts and are maintained transactionally by SQLite triggers.
CREATE TABLE mailbox_counts (
  identity_address TEXT PRIMARY KEY REFERENCES identities(address) ON DELETE CASCADE,
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread >= 0),
  inbox INTEGER NOT NULL DEFAULT 0 CHECK (inbox >= 0),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred >= 0),
  archive INTEGER NOT NULL DEFAULT 0 CHECK (archive >= 0),
  trash INTEGER NOT NULL DEFAULT 0 CHECK (trash >= 0),
  drafts INTEGER NOT NULL DEFAULT 0 CHECK (drafts >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash, drafts)
SELECT i.address,
  COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'inbox' AND m.unread = 1 THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'inbox' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'sent' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.starred = 1 AND m.folder != 'trash' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'archive' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'trash' THEN 1 ELSE 0 END), 0),
  (SELECT COUNT(*) FROM drafts d WHERE d.identity_address = i.address)
FROM identities i
LEFT JOIN messages m ON m.identity_address = i.address
GROUP BY i.address;

-- Address deletion intentionally preserves historical messages. If the same
-- identity is enabled again later, rebuild its counters from that history.
CREATE TRIGGER mailbox_counts_identities_after_insert
AFTER INSERT ON identities
BEGIN
  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash, drafts)
  SELECT NEW.address,
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'inbox' AND m.unread = 1 THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'inbox' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'sent' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.starred = 1 AND m.folder != 'trash' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'archive' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN m.status = 'ready' AND m.folder = 'trash' THEN 1 ELSE 0 END), 0),
    (SELECT COUNT(*) FROM drafts d WHERE d.identity_address = NEW.address)
  FROM (SELECT 1) seed
  LEFT JOIN messages m ON m.identity_address = NEW.address
  WHERE 1 = 1
  ON CONFLICT(identity_address) DO NOTHING;

  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.address, 1)
  ON CONFLICT(identity_address) DO NOTHING;
END;

CREATE TRIGGER mailbox_counts_messages_after_insert
AFTER INSERT ON messages
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash)
  VALUES (NEW.identity_address,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.unread = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'sent' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.starred = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'archive' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'trash' THEN 1 ELSE 0 END)
  ON CONFLICT(identity_address) DO UPDATE SET
    unread = unread + excluded.unread, inbox = inbox + excluded.inbox,
    sent = sent + excluded.sent, starred = starred + excluded.starred,
    archive = archive + excluded.archive, trash = trash + excluded.trash,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER mailbox_counts_messages_after_delete
AFTER DELETE ON messages
WHEN OLD.identity_address IS NOT NULL
BEGIN
  UPDATE mailbox_counts SET
    unread = unread - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.unread = 1 THEN 1 ELSE 0 END,
    inbox = inbox - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' THEN 1 ELSE 0 END,
    sent = sent - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'sent' THEN 1 ELSE 0 END,
    starred = starred - CASE WHEN OLD.status = 'ready' AND OLD.starred = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    archive = archive - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'archive' THEN 1 ELSE 0 END,
    trash = trash - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'trash' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;
END;

CREATE TRIGGER mailbox_counts_messages_after_update
AFTER UPDATE OF identity_address, status, folder, unread, starred ON messages
WHEN OLD.identity_address IS NOT NEW.identity_address
  OR OLD.status IS NOT NEW.status
  OR OLD.folder IS NOT NEW.folder
  OR OLD.unread IS NOT NEW.unread
  OR OLD.starred IS NOT NEW.starred
BEGIN
  UPDATE mailbox_counts SET
    unread = unread - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.unread = 1 THEN 1 ELSE 0 END,
    inbox = inbox - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' THEN 1 ELSE 0 END,
    sent = sent - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'sent' THEN 1 ELSE 0 END,
    starred = starred - CASE WHEN OLD.status = 'ready' AND OLD.starred = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    archive = archive - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'archive' THEN 1 ELSE 0 END,
    trash = trash - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'trash' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;

  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash)
  SELECT NEW.identity_address,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.unread = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'sent' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.starred = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'archive' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'trash' THEN 1 ELSE 0 END
  WHERE NEW.identity_address IS NOT NULL
  ON CONFLICT(identity_address) DO UPDATE SET
    unread = unread + excluded.unread, inbox = inbox + excluded.inbox,
    sent = sent + excluded.sent, starred = starred + excluded.starred,
    archive = archive + excluded.archive, trash = trash + excluded.trash,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER mailbox_counts_drafts_after_insert
AFTER INSERT ON drafts
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_counts (identity_address, drafts) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET drafts = drafts + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER mailbox_counts_drafts_after_delete
AFTER DELETE ON drafts
WHEN OLD.identity_address IS NOT NULL
BEGIN
  UPDATE mailbox_counts SET drafts = drafts - 1, updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;
END;

CREATE TRIGGER mailbox_counts_drafts_after_update
AFTER UPDATE OF identity_address ON drafts
WHEN OLD.identity_address IS NOT NEW.identity_address
BEGIN
  UPDATE mailbox_counts SET drafts = drafts - 1, updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;

  INSERT INTO mailbox_counts (identity_address, drafts)
  SELECT NEW.identity_address, 1 WHERE NEW.identity_address IS NOT NULL
  ON CONFLICT(identity_address) DO UPDATE SET drafts = drafts + 1, updated_at = CURRENT_TIMESTAMP;
END;

-- Match the native client's identity-scoped keyset pagination and thread reads.
CREATE INDEX messages_identity_ready_time_idx
  ON messages(identity_address, received_at DESC, id DESC)
  WHERE status = 'ready';
CREATE INDEX messages_identity_starred_time_idx
  ON messages(identity_address, received_at DESC, id DESC)
  WHERE status = 'ready' AND starred = 1 AND folder != 'trash';
CREATE INDEX messages_thread_identity_ready_time_idx
  ON messages(thread_id, identity_address, received_at DESC, id DESC)
  WHERE status = 'ready';

PRAGMA optimize;
