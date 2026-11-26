PRAGMA foreign_keys = ON;

-- External identities live on a foreign mail server (IMAP/SMTP) instead of
-- Cloudflare Email Routing. Their zone_id/routing_rule_id hold sentinel values.
ALTER TABLE identities ADD COLUMN kind TEXT NOT NULL DEFAULT 'routed' CHECK (kind IN ('routed', 'external'));

-- Preserves the origin IMAP folder name when it does not map 1:1 onto the
-- four local folders (custom folders are replicated into 'archive').
ALTER TABLE messages ADD COLUMN external_folder TEXT;

CREATE TABLE external_accounts (
  identity_address TEXT PRIMARY KEY REFERENCES identities(address) ON DELETE CASCADE,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  -- Name of the Worker secret binding that holds this account's password.
  -- The password itself is never stored in D1.
  password_secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One cursor per replicated IMAP folder. last_uid advances monotonically per
-- UIDVALIDITY generation; a UIDVALIDITY change resets the cursor and re-syncs.
CREATE TABLE external_sync_state (
  identity_address TEXT NOT NULL REFERENCES external_accounts(identity_address) ON DELETE CASCADE,
  imap_folder TEXT NOT NULL,
  local_folder TEXT NOT NULL CHECK (local_folder IN ('inbox', 'sent', 'archive', 'trash')),
  uidvalidity INTEGER,
  last_uid INTEGER NOT NULL DEFAULT 0 CHECK (last_uid >= 0),
  -- Push notifications stay suppressed until the initial backfill of a folder
  -- completes; only genuinely new mail should alert the iPhone.
  backfill_done INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),
  synced_messages INTEGER NOT NULL DEFAULT 0,
  skipped_messages INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_error TEXT,
  PRIMARY KEY (identity_address, imap_folder)
);
