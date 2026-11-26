-- Agent chats: the conversation history of the mail agent (the app's Agent
-- tab and lmail agent), and the emails it proposed in them. The agent never
-- sends: a proposed email is a draft card the owner edits and sends himself.

CREATE TABLE agent_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  -- The mailbox the chat was scoped to, if any.
  identity_address TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX agent_chats_updated_idx ON agent_chats(updated_at DESC);

CREATE TABLE agent_chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  -- What the agent did on the way: [{tool, label}].
  activity_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(activity_json)),
  -- Mail it looked at: [{id, subject, from, receivedAt, identity, read}].
  sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources_json)),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX agent_chat_messages_chat_idx ON agent_chat_messages(chat_id, created_at);

CREATE TABLE agent_chat_drafts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES agent_chat_messages(id) ON DELETE SET NULL,
  identity_address TEXT NOT NULL,
  to_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(to_json)),
  cc_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cc_json)),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  reply_to_message_id TEXT,
  -- 'superseded' when the agent wrote a revision of it.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'superseded', 'discarded')),
  sent_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX agent_chat_drafts_chat_idx ON agent_chat_drafts(chat_id, created_at);
