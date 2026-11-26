// The daily brief: one message in the owner's inbox at 07:00 owner local time with
// what needs them, what is urgent, and everything the autopilot did since the
// last brief (each with the id that undoes it). The structure is built from
// the database; GLM-5.3-Flash only turns each waiting mail into one line.

import { alertKey, readAutopilotSettings, tidyInbox, withinBudget, type ActionKind } from "./autopilot";
import { ownerTimezone } from "./config";
import { enqueuePushNotification } from "./push";
import { DRAFT_MODEL, ownText } from "./reply-drafts";
import { readModelText } from "./spam";
import type { Env } from "./types";
import { recordAiRun } from "./usage";

const BRIEF_HOUR = 7;
const WAITING_DAYS = 7;
const LIST_LIMIT = 8;

interface WaitingRow {
  id: string;
  subject: string;
  sender_name: string;
  sender_address: string;
  received_at: string;
  text_key: string | null;
  preview: string;
  triage_urgency: number | null;
  has_draft: number;
}

interface ActionSummaryRow {
  id: string;
  action: ActionKind;
  detail: string;
  subject: string;
  sender_name: string;
  sender_address: string;
}

export interface BriefResult {
  written: boolean;
  messageId?: string;
  reason?: string;
}

function localParts(date: Date, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Called by every cron tick; writes the brief in the first tick of 07:00 in OWNER_TIMEZONE. */
export async function maybeWriteDailyBrief(env: Env, now: Date): Promise<BriefResult> {
  const { day, hour } = localParts(now, ownerTimezone(env));
  if (hour !== BRIEF_HOUR) return { written: false, reason: "Not brief time" };
  const last = await env.DB.prepare("SELECT value FROM autopilot_settings WHERE key = 'autopilot.last_brief_day'").first<{ value: string }>();
  if (last?.value === day) return { written: false, reason: "Already written today" };
  return writeDailyBrief(env, now);
}

const name = (row: { sender_name: string; sender_address: string }) => row.sender_name || row.sender_address;
const shortId = (id: string) => id.slice(0, 8);

async function summarizeWaiting(env: Env, rows: WaitingRow[]): Promise<string[]> {
  const fallback = rows.map((row) => row.subject || "(no subject)");
  if (rows.length === 0) return fallback;
  const mails = await Promise.all(rows.map(async (row, index) => {
    const text = row.text_key ? await (await env.MAIL.get(row.text_key))?.text() ?? row.preview : row.preview;
    return `[${index + 1}] From: ${name(row)}\nSubject: ${row.subject}\n${ownText(text).slice(0, 700)}`;
  }));
  const startedAt = Date.now();
  try {
    const response = await env.AI.run(DRAFT_MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: "For each numbered mail, write one line of at most 14 words, in English: what the sender wants from the mailbox owner, "
          + "with any deadline. No names, no numbering. Answer with a JSON array of strings, one per mail, in order." },
        { role: "user", content: mails.join("\n\n") },
      ],
      max_tokens: 600, temperature: 0, reasoning_effort: "low",
    } as never) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    await recordAiRun(env, { kind: "brief", keyId: null, model: DRAFT_MODEL, prompt: null, identity: null, toolCalls: null,
      usage: { inputTokens: response?.usage?.prompt_tokens ?? 0, cachedInputTokens: 0, outputTokens: response?.usage?.completion_tokens ?? 0 },
      durationMs: Date.now() - startedAt });
    const match = readModelText(response).match(/\[[\s\S]*\]/);
    const lines: unknown = match ? JSON.parse(match[0]) : null;
    if (Array.isArray(lines) && lines.length === rows.length && lines.every((line) => typeof line === "string" && line.trim())) {
      return lines.map((line: string) => line.trim());
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "brief-summary-failed", error: String(error).slice(0, 300) }));
  }
  return fallback;
}

export async function composeBrief(env: Env, since: string): Promise<{ subject: string; text: string }> {
  const waitingSince = new Date(Date.now() - WAITING_DAYS * 86_400_000).toISOString();
  const [waiting, urgent, actions, spend] = await Promise.all([
    // Waiting on the owner: a person asked, the mail is still in the inbox, and
    // nothing was sent in that thread since.
    env.DB.prepare(`SELECT m.id, m.subject, m.sender_name, m.sender_address, m.received_at, m.text_key, m.preview, m.triage_urgency,
        EXISTS (SELECT 1 FROM drafts d WHERE d.reply_to_message_id = m.id) AS has_draft
      FROM messages m
      WHERE m.direction = 'inbound' AND m.status = 'ready' AND m.folder = 'inbox' AND m.spam = 0
        AND m.triage_needs_reply >= 0.5 AND m.received_at >= ?
        AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.thread_id AND r.direction = 'outbound' AND r.received_at > m.received_at)
      ORDER BY m.triage_urgency DESC, m.received_at DESC LIMIT ?`).bind(waitingSince, LIST_LIMIT).all<WaitingRow>(),
    env.DB.prepare(`SELECT id, subject, sender_name, sender_address, received_at, text_key, preview, triage_urgency, 0 AS has_draft
      FROM messages WHERE direction = 'inbound' AND status = 'ready' AND folder = 'inbox' AND spam = 0
        AND triage_urgency >= 2 AND COALESCE(triage_needs_reply, 0) < 0.5 AND received_at >= ?
      ORDER BY triage_urgency DESC, received_at DESC LIMIT ?`).bind(since, LIST_LIMIT * 4).all<WaitingRow>(),
    env.DB.prepare(`SELECT a.id, a.action, a.detail, m.subject, m.sender_name, m.sender_address
      FROM autopilot_actions a JOIN messages m ON m.id = a.message_id
      WHERE a.created_at >= ? AND a.undone_at IS NULL ORDER BY a.created_at DESC`).bind(since.replace("T", " ").slice(0, 19)).all<ActionSummaryRow>(),
    env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_runs WHERE kind IN ('triage', 'draft', 'brief') AND created_at >= ?`)
      .bind(since.replace("T", " ").slice(0, 19)).first<{ spent: number }>(),
  ]);
  const lines = await summarizeWaiting(env, waiting.results);
  const out: string[] = [];
  out.push(`Needs you (${waiting.results.length})`);
  if (waiting.results.length === 0) out.push("Nothing is waiting on you.");
  waiting.results.forEach((row, index) => out.push(`• ${name(row)}: ${lines[index]}${row.has_draft ? " A reply draft is ready." : ""}`));

  if (urgent.results.length) {
    out.push("", "Urgent");
    // One line per problem: alerts repeat.
    const lines = new Map<string, { row: WaitingRow; count: number }>();
    for (const row of urgent.results) {
      const key = `${row.sender_address} ${alertKey(row.subject)}`;
      const line = lines.get(key);
      if (line) line.count += 1;
      else lines.set(key, { row, count: 1 });
    }
    for (const { row, count } of lines.values()) {
      out.push(`• ${name(row)}: ${row.subject || "(no subject)"}${count > 1 ? ` (${count}×)` : ""}`);
    }
  }

  const groups: Array<[ActionKind, string]> = [["archive", "Archived"], ["spam", "Spam caught"], ["draft", "Reply drafts written"],
    ["read", "Marked read"], ["star", "Starred"]];
  const handled = actions.results.length;
  out.push("", `Handled for you (${handled})`);
  if (handled === 0) out.push("Nothing since the last brief.");
  for (const [kind, label] of groups) {
    const rows = actions.results.filter((row) => row.action === kind);
    if (!rows.length) continue;
    out.push(`${label}: ${rows.length}`);
    for (const row of rows.slice(0, LIST_LIMIT)) out.push(`  ${shortId(row.id)}  ${name(row)}: ${row.subject || "(no subject)"}`);
    if (rows.length > LIST_LIMIT) out.push(`  … and ${rows.length - LIST_LIMIT} more (lmail autopilot log)`);
  }
  out.push("", "Undo any of these with: lmail autopilot undo <id>", `Autopilot cost since the last brief: $${(spend?.spent ?? 0).toFixed(3)}`);

  const subject = waiting.results.length
    ? `Brief: ${waiting.results.length} waiting on you, ${handled} handled`
    : `Brief: nothing waiting, ${handled} handled`;
  return { subject, text: out.join("\n") };
}

function rfc822(from: string, to: string, subject: string, text: string, date: Date, id: string): string {
  const encodedSubject = `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`;
  return [`From: Autopilot <${from}>`, `To: <${to}>`, `Subject: ${encodedSubject}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <brief-${id}@lmail.autopilot>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit", "", text].join("\r\n");
}

export async function writeDailyBrief(env: Env, now = new Date()): Promise<BriefResult> {
  const settings = await readAutopilotSettings(env);
  if (!settings.enabled || !settings.brief) return { written: false, reason: "The brief is turned off" };
  if (!await withinBudget(env, settings)) return { written: false, reason: "Over today's autopilot budget" };
  const owner = await env.DB.prepare(`SELECT address FROM identities WHERE enabled = 1 AND kind = 'routed'
    ORDER BY address = ? DESC, created_at LIMIT 1`).bind(env.OWNER_EMAIL.toLowerCase()).first<{ address: string }>();
  if (!owner) return { written: false, reason: "No mailbox to deliver the brief to" };
  await tidyInbox(env);
  const lastAt = await env.DB.prepare("SELECT value FROM autopilot_settings WHERE key = 'autopilot.last_brief_at'").first<{ value: string }>();
  const since = lastAt?.value ?? new Date(now.getTime() - 86_400_000).toISOString();
  const { subject, text } = await composeBrief(env, since);

  const id = crypto.randomUUID();
  const rawKey = `raw/${id}.eml`;
  const textKey = `body/${id}.txt`;
  const raw = rfc822(owner.address, owner.address, subject, text, now, id);
  await Promise.all([
    env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } }),
    env.MAIL.put(textKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }),
  ]);
  const receivedAt = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages (id, thread_id, message_id, direction, folder, subject, sender_name, sender_address,
        recipients_json, preview, text_key, raw_key, received_at, size, status, identity_address,
        triage_category, triage_confidence, triage_spam, triage_needs_reply, triage_urgency, triage_model, triaged_at, drafted_at)
      VALUES (?, ?, ?, 'inbound', 'inbox', ?, 'Autopilot', ?, ?, ?, ?, ?, ?, ?, 'ready', ?, 'agent', 1, 0, 0, 0, 'autopilot', ?, ?)`)
      .bind(id, id, `<brief-${id}@lmail.autopilot>`, subject, owner.address, JSON.stringify([{ address: owner.address }]),
        text.replace(/\s+/g, " ").slice(0, 240), textKey, rawKey, receivedAt, raw.length, owner.address, receivedAt, receivedAt),
    // The brief is about mail, not mail itself: keep it out of the knowledge graph.
    env.DB.prepare("DELETE FROM kg_state WHERE message_id = ?").bind(id),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO autopilot_settings (key, value) VALUES ('autopilot.last_brief_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(receivedAt),
    env.DB.prepare(`INSERT INTO autopilot_settings (key, value) VALUES ('autopilot.last_brief_day', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(localParts(now, ownerTimezone(env)).day),
  ]);
  await enqueuePushNotification(env, id);
  return { written: true, messageId: id };
}
