-- Autopilot: every inbound message is triaged on arrival (category, spam,
-- needs-reply, urgency), the owner's rules act on confident verdicts, replies
-- are drafted for mail a person is waiting on, and a daily brief lands in the
-- inbox. Every action is logged with what it changed, so each one can be undone.

ALTER TABLE messages ADD COLUMN triage_category TEXT
  CHECK (triage_category IS NULL OR triage_category IN
    ('personal', 'school', 'agent', 'notification', 'code', 'receipt', 'newsletter', 'spam'));
ALTER TABLE messages ADD COLUMN triage_confidence REAL;
ALTER TABLE messages ADD COLUMN triage_spam REAL;
ALTER TABLE messages ADD COLUMN triage_needs_reply REAL;
ALTER TABLE messages ADD COLUMN triage_urgency INTEGER CHECK (triage_urgency IS NULL OR triage_urgency BETWEEN 0 AND 3);
ALTER TABLE messages ADD COLUMN triage_model TEXT;
ALTER TABLE messages ADD COLUMN triaged_at TEXT;
-- Set once a reply was drafted (or deliberately not), so a draft the owner
-- deleted is never written again.
ALTER TABLE messages ADD COLUMN drafted_at TEXT;

-- The catch-up sweep: recent inbound mail that has no verdict yet.
CREATE INDEX messages_untriaged_idx ON messages(received_at DESC)
  WHERE triaged_at IS NULL AND direction = 'inbound' AND status = 'ready';
CREATE INDEX messages_triage_time_idx ON messages(triaged_at DESC) WHERE triaged_at IS NOT NULL;

-- Kill switch, daily spending cap, and the brief's bookkeeping, as
-- 'autopilot.*' keys. Missing keys mean the defaults in autopilot.ts.
CREATE TABLE autopilot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE autopilot_rules (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN
    ('personal', 'school', 'agent', 'notification', 'code', 'receipt', 'newsletter')),
  action TEXT NOT NULL CHECK (action IN ('archive', 'read', 'star')),
  -- NULL: every address. Otherwise the rule only sees mail to this identity.
  identity_address TEXT,
  -- NULL: any sender. Otherwise an exact address or "@domain".
  sender_match TEXT,
  -- The rule leaves alone anything the triage rates more urgent than this.
  max_urgency INTEGER NOT NULL DEFAULT 3 CHECK (max_urgency BETWEEN 0 AND 3),
  min_confidence REAL NOT NULL DEFAULT 0.8 CHECK (min_confidence BETWEEN 0.5 AND 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Measured on 100 real inbound mails (2026-10-23): at confidence 0.8 these
-- touch 42 of the 67 automated mails and none that needed the owner. Login
-- codes stay in the inbox: they are wanted the minute they arrive.
INSERT INTO autopilot_rules (id, category, action, max_urgency) VALUES
  ('default-newsletter', 'newsletter', 'archive', 3),
  ('default-receipt', 'receipt', 'archive', 1),
  ('default-notification', 'notification', 'archive', 1);

CREATE TABLE autopilot_actions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES autopilot_rules(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('archive', 'read', 'star', 'spam', 'draft')),
  detail TEXT NOT NULL DEFAULT '',
  draft_id TEXT,
  previous_folder TEXT,
  previous_unread INTEGER,
  previous_starred INTEGER,
  previous_spam INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  undone_at TEXT
);
CREATE INDEX autopilot_actions_time_idx ON autopilot_actions(created_at DESC);
CREATE INDEX autopilot_actions_message_idx ON autopilot_actions(message_id);

-- The ledger learns three more kinds. Same rebuild as 0019: SQLite cannot
-- alter a CHECK constraint in place.
CREATE TABLE ai_runs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'kg-sync', 'spam', 'triage', 'draft', 'brief')),
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

PRAGMA optimize;
