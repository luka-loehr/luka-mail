// Reply drafts for mail a person is waiting on. GLM-5.3-Flash writes the reply
// in the owner's voice: a style guide learned from his sent mail, plus up to
// three mails he wrote earlier to the same person (or, failing that, to the
// same organisation). In a blind comparison against 50 of his real replies
// (2026-10-23) these drafts beat an un-tuned prompt 37 to 13, and 29 to 6 for
// mail to teachers. Drafts are only saved, never sent.

import { ownerName, ownerTimezone } from "./config";
import { replyStyle, signedForIdentity } from "./owner-profile";
import { readModelText } from "./spam";
import type { Env, MessageRow } from "./types";
import { recordAiRun } from "./usage";
import { readAutopilotSettings, withinBudget } from "./autopilot";

export const DRAFT_MODEL = "@cf/zai-org/glm-5.3-flash";
const EXAMPLES = 3;
const EXAMPLE_CHARS = 900;
const INCOMING_CHARS = 3_000;
// Mail providers shared by strangers: "same domain" says nothing about style.
const SHARED_DOMAINS = new Set(["gmail.com", "googlemail.com", "web.de", "gmx.de", "gmx.net", "outlook.com", "outlook.de",
  "hotmail.com", "hotmail.de", "icloud.com", "me.com", "yahoo.com", "yahoo.de", "t-online.de", "proton.me", "protonmail.com"]);

const QUOTE = /\n\s*(?:Am .{3,80} schrieb[^\n]*|-{3,}\s*Ursprüngliche Nachricht\s*-{3,}|-{3,}\s*Original Message\s*-{3,}|On .{3,120} wrote:|Von: [^\n]+|From: [^\n]+\nSent: [^\n]+|>[^\n]*)/i;
const SIGNATURE = /\n[\s\u200b]*-{6,}[\s\u200b]*\n[\s\S]*/;

/** The newest part of a mail: no quoted history, no trailing signature block. */
export function ownText(text: string): string {
  const unquoted = text.replace(/\r/g, "").split(QUOTE)[0] ?? "";
  return unquoted.replace(SIGNATURE, "").trim();
}

export function replySubject(subject: string): string {
  return /^\s*(re|aw|antw)\s*:/i.test(subject) ? subject : `Re: ${subject}`.trim();
}

function formatOwnerTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function likePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

interface ExampleRow {
  subject: string;
  text_key: string | null;
  received_at: string;
  recipients_json: string;
}

export async function earlierMails(env: Env, address: string, before: string): Promise<Array<ExampleRow & { text: string }>> {
  const query = (pattern: string, limit: number) => env.DB.prepare(`SELECT subject, text_key, received_at, recipients_json FROM messages
    WHERE direction = 'outbound' AND status = 'ready' AND folder != 'trash' AND text_key IS NOT NULL
      AND recipients_json LIKE ? ESCAPE '\\' AND received_at < ?
    ORDER BY received_at DESC LIMIT ?`).bind(pattern, before, limit).all<ExampleRow>();
  const rows = (await query(`%"${likePattern(address)}"%`, EXAMPLES * 2)).results;
  const domain = address.split("@")[1] ?? "";
  if (rows.length < EXAMPLES && domain && !SHARED_DOMAINS.has(domain)) {
    const seen = new Set(rows.map((row) => row.received_at));
    rows.push(...(await query(`%@${likePattern(domain)}"%`, EXAMPLES * 3)).results.filter((row) => !seen.has(row.received_at)));
  }
  const examples: Array<ExampleRow & { text: string }> = [];
  for (const row of rows) {
    if (examples.length >= EXAMPLES) break;
    const body = ownText(await (await env.MAIL.get(row.text_key!))?.text() ?? "");
    // Delivery checks and other machine-written mail teach nothing about style.
    if (body.length < 15 || /^automated\b/i.test(body)) continue;
    examples.push({ ...row, text: body });
  }
  return examples.reverse();
}

export function buildDraftPrompt(
  env: Partial<Pick<Env, "OWNER_NAME" | "OWNER_STYLE_GUIDE" | "OWNER_TIMEZONE">>,
  message: Pick<MessageRow, "sender_name" | "sender_address" | "recipients_json" | "subject" | "received_at">,
  incomingText: string,
  examples: Array<{ subject: string; received_at: string; recipients_json: string; text: string }>,
): Array<{ role: "system" | "user"; content: string }> {
  const name = ownerName(env);
  const style = replyStyle(env);
  const shots = examples.map((example) => `--- ${name} to ${recipientList(example.recipients_json)} (${example.received_at.slice(0, 10)}), `
    + `subject: ${example.subject}\n${example.text.slice(0, EXAMPLE_CHARS)}`).join("\n\n");
  const system = shots ? `${style}\n\n${name}'s earlier mails to this person or organisation:\n${shots}` : style;
  const from = message.sender_name ? `${message.sender_name} <${message.sender_address}>` : message.sender_address;
  const user = `From: ${from}\nTo: ${recipientList(message.recipients_json)}\nDate: ${formatOwnerTime(message.received_at, ownerTimezone(env))}\n`
    + `Subject: ${message.subject}\n\n${ownText(incomingText).slice(0, INCOMING_CHARS)}\n\nWrite ${name}'s reply.`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function recipientList(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map((entry: unknown) => typeof entry === "string" ? entry
        : typeof entry === "object" && entry !== null && "address" in entry ? String(entry.address) : "").filter(Boolean).join(", ");
    }
  } catch { /* not JSON */ }
  return "";
}

/** Strips what a chat model sometimes wraps around the body. */
export function cleanDraft(output: string): string {
  return output.replace(/^```[a-z]*\n?|```$/gim, "").replace(/^\s*(subject|betreff):[^\n]*\n+/i, "").trim();
}

export type DraftOutcome = "drafted" | "skipped" | "exists";

/**
 * Writes one reply draft. Idempotent: drafted_at is claimed in the same
 * transaction that saves the draft, so a redelivered job writes nothing. On
 * demand (the owner asked for this one) it drafts again whatever was drafted
 * before, and even while automatic drafts are off. Throws on a model failure
 * so the queue retries.
 */
export async function draftReply(env: Env, messageId: string, options: { onDemand?: boolean } = {}): Promise<DraftOutcome> {
  const message = await env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND direction = 'inbound' AND status = 'ready'`)
    .bind(messageId).first<MessageRow & { drafted_at: string | null }>();
  if (!message?.identity_address || (!options.onDemand && (message.drafted_at || message.spam))) return "exists";
  const settings = await readAutopilotSettings(env);
  if (!options.onDemand && (!settings.enabled || !settings.drafts)) return "skipped";
  if (!await withinBudget(env, settings)) return "skipped";

  const [incoming, examples] = await Promise.all([
    message.text_key ? env.MAIL.get(message.text_key).then((object) => object?.text() ?? message.preview) : Promise.resolve(message.preview),
    earlierMails(env, message.sender_address, message.received_at),
  ]);
  const messages = buildDraftPrompt(env, message, incoming, examples);
  const startedAt = Date.now();
  const response = await env.AI.run(DRAFT_MODEL as Parameters<Ai["run"]>[0],
    { messages, max_tokens: 700, temperature: 0.3, reasoning_effort: "low" } as never) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  await recordAiRun(env, { kind: "draft", keyId: null, model: DRAFT_MODEL, prompt: null, identity: message.identity_address,
    toolCalls: null, usage: { inputTokens: response?.usage?.prompt_tokens ?? 0, cachedInputTokens: 0,
      outputTokens: response?.usage?.completion_tokens ?? 0 }, durationMs: Date.now() - startedAt });
  let body = cleanDraft(readModelText(response));
  if (!body) throw new Error("The draft model returned no text");
  body = signedForIdentity(env, message.identity_address, body);

  const draftId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const claimed = `EXISTS (SELECT 1 FROM messages WHERE id = ? AND drafted_at = ?)`;
  const [claim] = await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET drafted_at = ? WHERE id = ? ${options.onDemand ? "" : "AND drafted_at IS NULL"}`).bind(stamp, messageId),
    env.DB.prepare(`INSERT INTO drafts (id, identity_address, reply_to_message_id, recipients_json, cc_json, bcc_json, subject, text_body)
      SELECT ?, ?, ?, ?, '[]', '[]', ?, ? WHERE ${claimed}`)
      .bind(draftId, message.identity_address, messageId, JSON.stringify([message.sender_address]), replySubject(message.subject), body,
        messageId, stamp),
    env.DB.prepare(`INSERT INTO autopilot_actions (id, message_id, action, detail, draft_id)
      SELECT ?, ?, 'draft', ?, ? WHERE ${claimed}`)
      .bind(crypto.randomUUID(), messageId, `reply draft (${examples.length} earlier mails as examples)`, draftId, messageId, stamp),
  ]);
  return claim?.meta.changes ? "drafted" : "exists";
}

/** The draft written for a message, for callers that want to show it. */
export async function latestDraft(env: Env, messageId: string): Promise<{ id: string; subject: string; text: string; to: string[] } | null> {
  const row = await env.DB.prepare(`SELECT id, subject, text_body, recipients_json FROM drafts WHERE reply_to_message_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(messageId).first<{ id: string; subject: string; text_body: string; recipients_json: string }>();
  return row ? { id: row.id, subject: row.subject, text: row.text_body, to: JSON.parse(row.recipients_json) as string[] } : null;
}
