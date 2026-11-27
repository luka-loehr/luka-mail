// The autopilot: the owner's rules acting on triage verdicts, an action log
// that can undo every step, and the catch-up sweep for mail that arrived while
// the triage models were unavailable (or through the IMAP backfill).
//
// What it may do is deliberately small: flag spam, archive, mark read, star,
// and write reply drafts. It never sends, deletes or forwards. A kill switch
// and a daily spending cap live in the settings table.

import { NEEDS_REPLY_THRESHOLD, SPAM_THRESHOLD, triageMail, type Category, type Triage } from "./triage";
import type { Env, MessageRow } from "./types";
import { autopilotSpendToday } from "./usage";

export const RULE_CATEGORIES = ["personal", "school", "agent", "notification", "code", "receipt", "newsletter"] as const;
export const RULE_ACTIONS = ["archive", "read", "star"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export type ActionKind = RuleAction | "spam" | "draft";

// Mail older than this is not triaged by the sweep: rules are for new mail.
const SWEEP_WINDOW_HOURS = 48;
const DRAFT_CATEGORIES: ReadonlySet<Category> = new Set(["personal", "school"]);

export interface AutopilotSettings {
  enabled: boolean;
  drafts: boolean;
  brief: boolean;
  dailyCapUsd: number;
}

const DEFAULT_SETTINGS: AutopilotSettings = { enabled: true, drafts: true, brief: true, dailyCapUsd: 0.5 };
const SETTING_KEYS: Record<keyof AutopilotSettings, string> = {
  enabled: "autopilot.enabled", drafts: "autopilot.drafts", brief: "autopilot.brief", dailyCapUsd: "autopilot.daily_cap_usd",
};

export async function readAutopilotSettings(env: Env): Promise<AutopilotSettings> {
  const rows = await env.DB.prepare("SELECT key, value FROM autopilot_settings WHERE key LIKE 'autopilot.%'").all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  const flag = (key: keyof AutopilotSettings) => {
    const value = values.get(SETTING_KEYS[key]);
    return value === undefined ? DEFAULT_SETTINGS[key] as boolean : value === "1";
  };
  const cap = Number(values.get(SETTING_KEYS.dailyCapUsd));
  return { enabled: flag("enabled"), drafts: flag("drafts"), brief: flag("brief"),
    dailyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_SETTINGS.dailyCapUsd };
}

export async function writeAutopilotSettings(env: Env, patch: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
  const statements = (Object.keys(patch) as Array<keyof AutopilotSettings>)
    .filter((key) => patch[key] !== undefined)
    .map((key) => {
      const value = patch[key];
      return env.DB.prepare(`INSERT INTO autopilot_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
        .bind(SETTING_KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    });
  if (statements.length) await env.DB.batch(statements);
  return readAutopilotSettings(env);
}

/** True while today's autopilot spending is under the cap. */
export async function withinBudget(env: Env, settings: AutopilotSettings): Promise<boolean> {
  return await autopilotSpendToday(env) < settings.dailyCapUsd;
}

export interface RuleRow {
  id: string;
  category: Category;
  action: RuleAction;
  identity_address: string | null;
  sender_match: string | null;
  max_urgency: number;
  min_confidence: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export async function listRules(env: Env): Promise<RuleRow[]> {
  return (await env.DB.prepare("SELECT * FROM autopilot_rules ORDER BY category, action, id").all<RuleRow>()).results;
}

export interface MessageState {
  folder: MessageRow["folder"];
  unread: number;
  starred: number;
  spam: number;
  senderAddress: string;
  identityAddress: string | null;
}

export interface PlannedAction {
  ruleId: string | null;
  action: ActionKind;
  detail: string;
}

export interface Decision {
  folder: MessageRow["folder"];
  unread: number;
  starred: number;
  spam: number;
  actions: PlannedAction[];
  draft: boolean;
}

function senderMatches(pattern: string | null, sender: string): boolean {
  if (!pattern) return true;
  const value = pattern.toLowerCase();
  return value.startsWith("@") ? sender.endsWith(value) : sender === value;
}

/**
 * What the autopilot does with one triaged message. Pure: the caller writes
 * the result. Trusted senders (own identities, contacts) are never spam; rules
 * never touch mail a person is waiting on, and only act while enabled.
 */
export function decide(triage: Triage, state: MessageState, rules: RuleRow[], options: { trusted: boolean; settings: AutopilotSettings }): Decision {
  const decision: Decision = { folder: state.folder, unread: state.unread, starred: state.starred, spam: state.spam, actions: [], draft: false };
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (!options.trusted && triage.spam >= SPAM_THRESHOLD) {
    if (!state.spam) {
      decision.spam = 1;
      decision.actions.push({ ruleId: null, action: "spam", detail: `spam ${pct(triage.spam)}` });
    }
    return decision;
  }
  if (!options.settings.enabled) return decision;
  const waitedOn = triage.needsReply >= NEEDS_REPLY_THRESHOLD;
  if (!waitedOn) {
    for (const rule of rules) {
      if (!rule.enabled || rule.category !== triage.category || triage.confidence < rule.min_confidence) continue;
      if (triage.urgency > rule.max_urgency) continue;
      if (rule.identity_address && rule.identity_address !== state.identityAddress) continue;
      if (!senderMatches(rule.sender_match, state.senderAddress)) continue;
      const detail = `${triage.category} ${pct(triage.confidence)}, urgency ${triage.urgency}`;
      if (rule.action === "archive" && decision.folder === "inbox") {
        decision.folder = "archive";
        decision.unread = 0;
        decision.actions.push({ ruleId: rule.id, action: "archive", detail });
      } else if (rule.action === "read" && decision.unread) {
        decision.unread = 0;
        decision.actions.push({ ruleId: rule.id, action: "read", detail });
      } else if (rule.action === "star" && !decision.starred) {
        decision.starred = 1;
        decision.actions.push({ ruleId: rule.id, action: "star", detail });
      }
    }
  }
  decision.draft = waitedOn && options.settings.drafts && DRAFT_CATEGORIES.has(triage.category) && decision.folder === "inbox";
  return decision;
}

export function triageAssignments(triage: Triage | null): { sql: string; bindings: Array<string | number | null> } {
  if (!triage) return { sql: "", bindings: [] };
  return {
    sql: `triage_category = ?, triage_confidence = ?, triage_spam = ?, triage_needs_reply = ?, triage_urgency = ?,
      triage_model = ?, triaged_at = ?,`,
    bindings: [triage.category, round(triage.confidence), round(triage.spam), round(triage.needsReply), triage.urgency,
      triage.model, new Date().toISOString()],
  };
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function actionLogStatements(env: Env, messageId: string, decision: Decision, before: MessageState): D1PreparedStatement[] {
  return decision.actions.map((planned) => env.DB.prepare(`INSERT INTO autopilot_actions
    (id, message_id, rule_id, action, detail, previous_folder, previous_unread, previous_starred, previous_spam)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), messageId, planned.ruleId, planned.action, planned.detail,
      before.folder, before.unread, before.starred, before.spam));
}

export async function enqueueDraft(env: Env, messageId: string): Promise<void> {
  await env.MAIL_QUEUE.send({ kind: "draft", messageId });
}

// Machine alerts repeat: a fleet alarm can mail the same subject every few
// minutes, and a "RESOLVED" follows its alert. Only the newest copy of an
// alert stays in the inbox, and a resolved alert leaves it entirely.
const REPEAT_WINDOW_DAYS = 14;
const REPEATING_CATEGORIES: ReadonlySet<Category> = new Set(["notification", "agent"]);
const STATUS_WORDS = /\b(alert|alarm|firing|triggered|warning|resolved|recovered|cleared)\b/gi;
const RESOLVED = /\b(resolved|recovered|cleared)\b/i;
// CloudWatch: 'ALARM: "name" in region', then 'OK: "name" in region'.
const ALARM_STATE = /^\s*(ok|alarm|insufficient[_ ]data)\s*:\s*/i;

export function isResolution(subject: string): boolean {
  return RESOLVED.test(subject) || /^\s*ok\s*:/i.test(subject);
}

/** The part of an alert's subject that names the problem, without its status, timestamps and counters. */
export function alertKey(subject: string): string {
  return subject.toLowerCase()
    .replace(/^((re|fwd?|aw|wg)\s*:\s*)+/, "")
    .replace(ALARM_STATE, "")
    .replace(STATUS_WORDS, " ")
    .replace(/\d{4}-\d{2}-\d{2}[t ]?[\d:.+z-]*/g, "#")
    .replace(/\b\d{3,}\b/g, "#")
    .replace(/[^\p{L}\p{N}#[\]+ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a resolution names the same problem as an alert. Alerts often carry
 * a prefix the resolution drops ("[Service] Compute 1 is not reachable" and
 * "Resolved: Compute 1 is not reachable"), so a key of three or more words
 * that ends the other one matches too.
 */
export function resolves(resolutionKey: string, alert: string): boolean {
  if (resolutionKey === alert) return true;
  const [shorter, longer] = resolutionKey.length <= alert.length ? [resolutionKey, alert] : [alert, resolutionKey];
  return shorter.split(" ").length >= 3 && longer.endsWith(` ${shorter}`);
}

export interface RelatedAction {
  messageId: string;
  before: MessageState;
  detail: string;
}

export interface ArrivalMessage {
  id: string;
  subject: string;
  senderAddress: string;
  identityAddress: string | null;
  receivedAt: string;
  senderAuthenticated?: boolean;
}

/**
 * Older inbox copies of the same alert, filed away by a newer one. A resolved
 * alert also files itself. `quiet` is true when the alert repeats a copy the
 * owner has not read yet: the phone was told already.
 */
export async function collapseRepeats(env: Env, message: ArrivalMessage, triage: Triage, decision: Decision):
  Promise<{ related: RelatedAction[]; quiet: boolean }> {
  if (!message.senderAuthenticated || !REPEATING_CATEGORIES.has(triage.category) || decision.folder !== "inbox" || decision.spam) {
    return { related: [], quiet: false };
  }
  const key = alertKey(message.subject);
  if (key.length < 4) return { related: [], quiet: false };
  const resolved = isResolution(message.subject);
  const rows = await env.DB.prepare(`SELECT id, subject, folder, unread, starred, spam FROM messages
    WHERE direction = 'inbound' AND status = 'ready' AND folder = 'inbox' AND spam = 0 AND id != ?
      AND sender_authenticated = 1 AND identity_address IS ? AND sender_address = ? AND received_at >= ? AND received_at <= ?
    ORDER BY received_at DESC LIMIT 200`)
    .bind(message.id, message.identityAddress, message.senderAddress,
      new Date(Date.parse(message.receivedAt) - REPEAT_WINDOW_DAYS * 86_400_000).toISOString(), message.receivedAt)
    .all<{ id: string; subject: string; folder: MessageRow["folder"]; unread: number; starred: number; spam: number }>();
  const copies = rows.results.filter((row) => !row.starred
    && (resolved ? resolves(key, alertKey(row.subject)) : alertKey(row.subject) === key));
  const related = copies.map((row) => ({ messageId: row.id, detail: resolved ? "alert resolved" : "repeated by a newer copy",
    before: { folder: row.folder, unread: row.unread, starred: row.starred, spam: row.spam,
      senderAddress: message.senderAddress, identityAddress: message.identityAddress } }));
  if (resolved) {
    decision.folder = "archive";
    decision.unread = 0;
    decision.draft = false;
    decision.actions.push({ ruleId: null, action: "archive", detail: "alert resolved" });
  }
  return { related, quiet: !resolved && copies.some((row) => row.unread) };
}

/** Files the related copies; each log row is written only if its message really moved. */
export function relatedStatements(env: Env, related: RelatedAction[]): D1PreparedStatement[] {
  return related.flatMap((item) => [
    env.DB.prepare(`UPDATE messages SET folder = 'archive', unread = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND folder = 'inbox'`).bind(item.messageId),
    env.DB.prepare(`INSERT INTO autopilot_actions (id, message_id, action, detail, previous_folder, previous_unread, previous_starred, previous_spam)
      SELECT ?, ?, 'archive', ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), item.messageId, item.detail, item.before.folder, item.before.unread, item.before.starred, item.before.spam),
  ]);
}

interface TidyRow {
  id: string;
  subject: string;
  sender_address: string;
  identity_address: string | null;
  unread: number;
  starred: number;
}

/**
 * Applies the alert rules to mail already in the inbox: every copy but the
 * newest of an alert, and every alert a later mail resolved (with that
 * resolution), are filed. Arrival does this for new mail; this catches mail
 * that arrived untriaged or before a rule existed. No model is asked.
 */
export async function tidyInbox(env: Env): Promise<number> {
  const settings = await readAutopilotSettings(env);
  if (!settings.enabled) return 0;
  const rows = await env.DB.prepare(`SELECT id, subject, sender_address, identity_address, unread, starred FROM messages
    WHERE direction = 'inbound' AND status = 'ready' AND folder = 'inbox' AND spam = 0 AND sender_authenticated = 1
      AND triage_category IN ('notification', 'agent') AND received_at >= ?
    ORDER BY received_at DESC, id DESC`)
    .bind(new Date(Date.now() - REPEAT_WINDOW_DAYS * 86_400_000).toISOString()).all<TidyRow>();
  const groups = new Map<string, TidyRow[]>();
  for (const row of rows.results) {
    const group = `${row.identity_address ?? ""}\u0000${row.sender_address}`;
    groups.set(group, [...groups.get(group) ?? [], row]);
  }
  const related: RelatedAction[] = [];
  const file = (row: TidyRow, detail: string) => {
    if (row.starred || related.some((item) => item.messageId === row.id)) return;
    related.push({ messageId: row.id, detail, before: { folder: "inbox", unread: row.unread, starred: row.starred, spam: 0,
      senderAddress: row.sender_address, identityAddress: row.identity_address } });
  };
  for (const newestFirst of groups.values()) {
    const seen = new Set<string>();
    newestFirst.forEach((row, index) => {
      const key = alertKey(row.subject);
      if (key.length < 4) return;
      if (isResolution(row.subject)) {
        file(row, "alert resolved");
        for (const older of newestFirst.slice(index + 1)) {
          if (!isResolution(older.subject) && resolves(key, alertKey(older.subject))) file(older, "alert resolved");
        }
      } else if (seen.has(key)) {
        file(row, "repeated by a newer copy");
      }
      seen.add(key);
    });
  }
  if (related.length) await env.DB.batch(relatedStatements(env, related));
  return related.length;
}

export interface ArrivalPlan {
  triage: Triage;
  decision: Decision;
  related: RelatedAction[];
  // Do not announce: the owner was told about this alert already.
  quiet: boolean;
}

/**
 * Everything the arrival paths need: the verdict, what it changes, and the
 * rows to write. Returns null when triage is unavailable (the sweep retries).
 */
export async function planArrival(env: Env, input: Parameters<typeof triageMail>[1], before: MessageState, trusted: boolean,
  message: ArrivalMessage): Promise<ArrivalPlan | null> {
  const settings = await readAutopilotSettings(env);
  if (!await withinBudget(env, settings)) {
    console.warn(JSON.stringify({ event: "autopilot-over-budget", capUsd: settings.dailyCapUsd }));
    return null;
  }
  const triage = await triageMail(env, input);
  if (!triage) return null;
  const rules = settings.enabled ? await listRules(env) : [];
  const decision = decide(triage, before, rules, { trusted, settings });
  const { related, quiet } = settings.enabled ? await collapseRepeats(env, message, triage, decision) : { related: [], quiet: false };
  return { triage, decision, related, quiet };
}

interface SweepRow {
  id: string;
  folder: MessageRow["folder"];
  unread: number;
  starred: number;
  spam: number;
  sender_name: string;
  sender_address: string;
  recipients_json: string;
  subject: string;
  preview: string;
  text_key: string | null;
  received_at: string;
  identity_address: string | null;
  sender_authenticated: number | null;
  trusted: number;
}

export interface SweepReport {
  triaged: number;
  spam: number;
  actions: number;
  drafts: number;
  stoppedEarly: boolean;
}

/** Triage recent inbound mail that has no verdict yet. Runs from the cron. */
export async function runAutopilotSweep(env: Env, options: { maxMessages: number; deadlineMs: number }): Promise<SweepReport> {
  const report: SweepReport = { triaged: 0, spam: 0, actions: 0, drafts: 0, stoppedEarly: false };
  const startedAt = Date.now();
  const settings = await readAutopilotSettings(env);
  const rows = await env.DB.prepare(`SELECT m.id, m.folder, m.unread, m.starred, m.spam, m.sender_name, m.sender_address,
      m.recipients_json, m.subject, m.preview, m.text_key, m.received_at, m.identity_address, m.sender_authenticated,
      (m.sender_authenticated = 1 AND (EXISTS (SELECT 1 FROM identities i WHERE i.address = m.sender_address)
        OR EXISTS (SELECT 1 FROM contacts c WHERE c.address = m.sender_address
          AND (m.identity_address IS NULL OR c.identity_address = m.identity_address)))) AS trusted
    FROM messages m
    WHERE m.triaged_at IS NULL AND m.direction = 'inbound' AND m.status = 'ready'
      AND m.received_at >= ? ORDER BY m.received_at DESC LIMIT ?`)
    .bind(new Date(Date.now() - SWEEP_WINDOW_HOURS * 3_600_000).toISOString(), options.maxMessages).all<SweepRow>();
  const rules = settings.enabled ? await listRules(env) : [];
  for (const row of rows.results) {
    if (Date.now() - startedAt > options.deadlineMs || !await withinBudget(env, settings)) {
      report.stoppedEarly = true;
      break;
    }
    const text = row.text_key ? await (await env.MAIL.get(row.text_key))?.text() ?? row.preview : row.preview;
    const triage = await triageMail(env, {
      messageId: row.id, senderName: row.sender_name, senderAddress: row.sender_address,
      recipients: addressesOf(row.recipients_json), subject: row.subject, receivedAt: row.received_at,
      text, identityAddress: row.identity_address,
    });
    if (!triage) {
      report.stoppedEarly = true;
      break;
    }
    const before: MessageState = { folder: row.folder, unread: row.unread, starred: row.starred, spam: row.spam,
      senderAddress: row.sender_address, identityAddress: row.identity_address };
    // Mail the owner already moved is his: only the verdict is recorded.
    const decision = row.folder === "inbox"
      ? decide(triage, before, rules, { trusted: Boolean(row.trusted), settings })
      : { ...before, actions: [], draft: false };
    const { related } = settings.enabled && row.folder === "inbox"
      ? await collapseRepeats(env, { id: row.id, subject: row.subject, senderAddress: row.sender_address,
        identityAddress: row.identity_address, receivedAt: row.received_at,
        senderAuthenticated: row.sender_authenticated === 1 }, triage, decision)
      : { related: [] };
    const assignments = triageAssignments(triage);
    const update = env.DB.prepare(`UPDATE messages SET ${assignments.sql} folder = ?, unread = ?, starred = ?, spam = ?,
      spam_model = ?, spam_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND folder = ? AND triaged_at IS NULL`)
      .bind(...assignments.bindings, decision.folder, decision.unread, decision.starred, decision.spam, triage.model, row.id, row.folder);
    const results = await env.DB.batch([update, ...actionLogStatements(env, row.id, decision, before), ...relatedStatements(env, related)]);
    if (!results[0]?.meta.changes) continue;
    report.triaged += 1;
    report.actions += decision.actions.length + related.length;
    if (decision.spam && !row.spam) report.spam += 1;
    if (decision.draft) {
      await enqueueDraft(env, row.id);
      report.drafts += 1;
    }
  }
  return report;
}

function addressesOf(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map((entry: unknown) => typeof entry === "string" ? entry
        : typeof entry === "object" && entry !== null && "address" in entry ? String(entry.address) : "").filter(Boolean).join(", ");
    }
  } catch { /* stored recipients are not JSON */ }
  return "";
}

export interface ActionRow {
  id: string;
  message_id: string;
  rule_id: string | null;
  action: ActionKind;
  detail: string;
  draft_id: string | null;
  previous_folder: MessageRow["folder"] | null;
  previous_unread: number | null;
  previous_starred: number | null;
  previous_spam: number | null;
  created_at: string;
  undone_at: string | null;
  subject?: string;
  sender_address?: string;
  identity_address?: string | null;
}

/**
 * Reverts one logged action when the message still shows its effect. The
 * owner may have changed the message since; that change wins.
 */
export async function undoAction(env: Env, action: ActionRow): Promise<{ undone: boolean; reason?: string }> {
  if (action.undone_at) return { undone: false, reason: "Already undone" };
  let statement: D1PreparedStatement;
  switch (action.action) {
    case "archive":
      statement = env.DB.prepare(`UPDATE messages SET folder = ?, unread = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND folder = 'archive'`).bind(action.previous_folder ?? "inbox", action.previous_unread ?? 1, action.message_id);
      break;
    case "read":
      statement = env.DB.prepare("UPDATE messages SET unread = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND unread = 0")
        .bind(action.message_id);
      break;
    case "star":
      statement = env.DB.prepare("UPDATE messages SET starred = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND starred = 1")
        .bind(action.message_id);
      break;
    case "spam":
      statement = env.DB.prepare("UPDATE messages SET spam = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND spam = 1")
        .bind(action.message_id);
      break;
    case "draft":
      statement = env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(action.draft_id ?? "");
      break;
  }
  const [result] = await env.DB.batch([statement,
    env.DB.prepare("UPDATE autopilot_actions SET undone_at = CURRENT_TIMESTAMP WHERE id = ? AND undone_at IS NULL").bind(action.id)]);
  if (!result?.meta.changes) return { undone: true, reason: "The message no longer shows this change; marked undone" };
  return { undone: true };
}
