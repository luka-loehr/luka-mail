// Saved agent chats: the history behind the app's Agent tab (and lmail
// agent). A turn streams like a one-off agent run; before the stream closes,
// the answer, what the agent did, and the mail it looked at are stored, so a
// chat reads the same on every device. Emails the agent proposed live beside
// the chat as drafts: the owner edits them, and only an explicit send request
// from a client (after his confirmation) sends one.

import type { LanguageModel, ModelMessage } from "ai";
import { runMailAgentStream, type ActivityItem, type AgentRunRequest, type SourceItem } from "./agent";
import type { AuthPrincipal } from "./auth";
import { DRAFT_MODEL } from "./reply-drafts";
import { readModelText } from "./spam";
import type { Env } from "./types";
import { recordAiRun } from "./usage";

const HISTORY_MESSAGES = 24;
const HISTORY_CHARS = 6_000;

interface ChatRow {
  id: string;
  title: string;
  identity_address: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  activity_json: string;
  sources_json: string;
  error: string | null;
  created_at: string;
}

export interface ChatDraftRow {
  id: string;
  chat_id: string;
  message_id: string | null;
  identity_address: string;
  to_json: string;
  cc_json: string;
  subject: string;
  body: string;
  reply_to_message_id: string | null;
  status: "draft" | "sent" | "superseded" | "discarded";
  sent_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/** SQLite's CURRENT_TIMESTAMP ("2026-10-23 09:41:07") as ISO 8601 in UTC, which clients parse. */
export function isoTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

const parsed = <T>(json: string, fallback: T): T => {
  try { return JSON.parse(json) as T; } catch { return fallback; }
};

export function publicChatDraft(row: ChatDraftRow) {
  return { id: row.id, chatId: row.chat_id, messageId: row.message_id, from: row.identity_address,
    to: parsed<string[]>(row.to_json, []), cc: parsed<string[]>(row.cc_json, []), subject: row.subject, body: row.body,
    replyToMessageId: row.reply_to_message_id, status: row.status, sentMessageId: row.sent_message_id,
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at) };
}

function publicChat(row: ChatRow & { preview?: string | null }) {
  return { id: row.id, title: row.title || "New Chat", identity: row.identity_address, preview: row.preview ?? "",
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at) };
}

export async function listChats(env: Env, limit: number) {
  const rows = await env.DB.prepare(`SELECT c.*, (SELECT substr(m.content, 1, 160) FROM agent_chat_messages m
      WHERE m.chat_id = c.id AND m.role = 'assistant' AND m.content != '' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview
    FROM agent_chats c ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`).bind(limit).all<ChatRow & { preview: string | null }>();
  return rows.results.map(publicChat);
}

export async function readChat(env: Env, id: string) {
  const chat = await env.DB.prepare("SELECT * FROM agent_chats WHERE id = ?").bind(id).first<ChatRow>();
  if (!chat) return null;
  const [messages, drafts] = await env.DB.batch<ChatMessageRow | ChatDraftRow>([
    env.DB.prepare("SELECT * FROM agent_chat_messages WHERE chat_id = ? ORDER BY created_at, rowid").bind(id),
    env.DB.prepare("SELECT * FROM agent_chat_drafts WHERE chat_id = ? ORDER BY created_at, rowid").bind(id),
  ]);
  const draftRows = (drafts?.results ?? []) as ChatDraftRow[];
  return {
    chat: publicChat(chat),
    messages: ((messages?.results ?? []) as ChatMessageRow[]).map((row) => ({
      id: row.id, role: row.role, content: row.content, createdAt: isoTimestamp(row.created_at), error: row.error,
      activity: parsed<ActivityItem[]>(row.activity_json, []), sources: parsed<SourceItem[]>(row.sources_json, []),
      drafts: draftRows.filter((draft) => draft.message_id === row.id).map(publicChatDraft),
    })),
  };
}

/** Earlier turns as model messages, each proposed email shown as it stands now (edited, sent or replaced). */
async function history(env: Env, chatId: string, before: string[]): Promise<ModelMessage[]> {
  const [messages, drafts] = await env.DB.batch<ChatMessageRow | ChatDraftRow>([
    env.DB.prepare(`SELECT * FROM (SELECT *, rowid AS r FROM agent_chat_messages WHERE chat_id = ? AND id NOT IN (?, ?)
      ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, r`).bind(chatId, before[0] ?? "", before[1] ?? "", HISTORY_MESSAGES),
    env.DB.prepare("SELECT * FROM agent_chat_drafts WHERE chat_id = ? ORDER BY created_at, rowid").bind(chatId),
  ]);
  const draftRows = (drafts?.results ?? []) as ChatDraftRow[];
  return ((messages?.results ?? []) as ChatMessageRow[]).flatMap((row): ModelMessage[] => {
    if (row.role === "user") return [{ role: "user", content: row.content.slice(0, HISTORY_CHARS) }];
    const emails = draftRows.filter((draft) => draft.message_id === row.id).map((draft) => {
      const state = { draft: "not sent yet; the owner may have edited it", sent: "sent by the owner", superseded: "replaced by a revision",
        discarded: "discarded by the owner" }[draft.status];
      return `[Email ${draft.id} (${state})]\nFrom: ${draft.identity_address}\nTo: ${parsed<string[]>(draft.to_json, []).join(", ")}`
        + `${draft.cc_json !== "[]" ? `\nCc: ${parsed<string[]>(draft.cc_json, []).join(", ")}` : ""}\nSubject: ${draft.subject}\n\n${draft.body}`;
    });
    const content = [row.content.slice(0, HISTORY_CHARS), ...emails].filter(Boolean).join("\n\n");
    return content ? [{ role: "assistant", content }] : [];
  });
}

async function chatTitle(env: Env, text: string): Promise<string> {
  const fallback = text.replace(/\s+/g, " ").trim().slice(0, 48);
  const startedAt = Date.now();
  try {
    const response = await env.AI.run(DRAFT_MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: "Give this chat a title of 2 to 5 words in the language of the message. Answer with the title only, no quotes." },
        { role: "user", content: text.slice(0, 1_000) },
      ],
      max_tokens: 40, temperature: 0.2, reasoning_effort: "low",
    } as never) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    await recordAiRun(env, { kind: "agent", keyId: null, model: DRAFT_MODEL, prompt: null, identity: null, toolCalls: null,
      usage: { inputTokens: response?.usage?.prompt_tokens ?? 0, cachedInputTokens: 0, outputTokens: response?.usage?.completion_tokens ?? 0 },
      durationMs: Date.now() - startedAt });
    const title = readModelText(response).replace(/^["'„“]+|["'“”.]+$/g, "").replace(/\s+/g, " ").trim();
    return title && title.length <= 60 ? title : fallback;
  } catch {
    return fallback;
  }
}

export interface ChatTurnInput {
  chatId?: string;
  text: string;
  identity?: string;
  maxSteps: number;
  // The owner's own chats: the agent sees every mailbox, not just the ones the
  // calling key lists (keys predate mailboxes added later, like hi@).
  fullAccess?: boolean;
}

/** One turn of a chat (a new chat when no id is given), streamed as NDJSON. Null when the chat does not exist. */
export async function runChatTurn(env: Env, principal: AuthPrincipal, input: ChatTurnInput,
  waitUntil?: (promise: Promise<unknown>) => void, modelOverride?: LanguageModel): Promise<Response | null> {
  let chat: ChatRow | null = null;
  if (input.chatId) {
    chat = await env.DB.prepare("SELECT * FROM agent_chats WHERE id = ?").bind(input.chatId).first<ChatRow>();
    if (!chat) return null;
  }
  const chatId = chat?.id ?? crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const identity = input.identity ?? chat?.identity_address ?? undefined;
  // The assistant row exists from the start (proposed emails point at it) and
  // stays marked incomplete until the turn is recorded.
  await env.DB.batch([
    ...(chat ? [] : [env.DB.prepare("INSERT INTO agent_chats (id, identity_address, created_by) VALUES (?, ?, ?)")
      .bind(chatId, identity ?? null, principal.keyId)]),
    env.DB.prepare("INSERT INTO agent_chat_messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)").bind(userMessageId, chatId, input.text),
    env.DB.prepare(`INSERT INTO agent_chat_messages (id, chat_id, role, content, error, created_at)
      VALUES (?, ?, 'assistant', '', 'incomplete', CURRENT_TIMESTAMP)`).bind(assistantMessageId, chatId),
  ]);
  const earlier = chat ? await history(env, chatId, [userMessageId, assistantMessageId]) : [];
  const request: AgentRunRequest = { prompt: input.text, identity, maxSteps: input.maxSteps };
  const agentPrincipal: AuthPrincipal = input.fullAccess ? { ...principal, allowedIdentities: null } : principal;
  return runMailAgentStream(env, agentPrincipal, request, modelOverride, {
    history: earlier,
    chat: { chatId, messageId: assistantMessageId },
    waitUntil,
    firstEvent: { type: "chat", chatId, userMessageId, assistantMessageId },
    onComplete: async (turn) => {
      await env.DB.batch([
        env.DB.prepare(`UPDATE agent_chat_messages SET content = ?, activity_json = ?, sources_json = ?, error = ? WHERE id = ?`)
          .bind(turn.text, JSON.stringify(turn.activity), JSON.stringify(turn.sources), turn.error, assistantMessageId),
        env.DB.prepare("UPDATE agent_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(chatId),
      ]);
      if (chat?.title) return [];
      const title = await chatTitle(env, input.text);
      await env.DB.prepare("UPDATE agent_chats SET title = ? WHERE id = ?").bind(title, chatId).run();
      return [{ type: "title", chatId, title }];
    },
  });
}

export interface DraftPatch {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  status?: "draft" | "discarded";
}

/** Stores the owner's edits to a proposed email. Sent emails stay as they were sent. */
export async function updateChatDraft(env: Env, chatId: string, draftId: string, patch: DraftPatch): Promise<ChatDraftRow | null> {
  const columns: Array<[string, string]> = [];
  if (patch.from !== undefined) columns.push(["identity_address", patch.from.toLowerCase()]);
  if (patch.to !== undefined) columns.push(["to_json", JSON.stringify(patch.to.map((address) => address.toLowerCase()))]);
  if (patch.cc !== undefined) columns.push(["cc_json", JSON.stringify(patch.cc.map((address) => address.toLowerCase()))]);
  if (patch.subject !== undefined) columns.push(["subject", patch.subject]);
  if (patch.body !== undefined) columns.push(["body", patch.body]);
  if (patch.status !== undefined) columns.push(["status", patch.status]);
  if (columns.length) {
    await env.DB.prepare(`UPDATE agent_chat_drafts SET ${columns.map(([column]) => `${column} = ?`).join(", ")},
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND chat_id = ? AND status != 'sent'`)
      .bind(...columns.map(([, value]) => value), draftId, chatId).run();
  }
  return env.DB.prepare("SELECT * FROM agent_chat_drafts WHERE id = ? AND chat_id = ?").bind(draftId, chatId).first<ChatDraftRow>();
}

export async function markChatDraftSent(env: Env, draftId: string, sentMessageId: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE agent_chat_drafts SET status = 'sent', sent_message_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(sentMessageId, draftId).run();
}
