// Replicates external IMAP accounts into the local D1/R2 mail store,
// and provides the SMTP send path for those identities. Sync is one-way:
// the external server is the receiving transport, this store is the operating copy.

import PostalMime from "postal-mime";
import { sha256, stableId } from "./crypto";
import { cleanHeader, findThreadForReply, normalizeAddresses, prepareAttachment, preview } from "./inbound";
import { ImapClient, connectTlsTransport, parseInternalDate, type ImapFolder, type ImapTransport } from "./imap";
import { actionLogStatements, enqueueDraft, planArrival, relatedStatements, triageAssignments, type MessageState } from "./autopilot";
import { enqueuePushNotification } from "./push";
import { isTrustedSender } from "./spam";
import type { Env, ExternalAccountRow, ExternalSyncStateRow } from "./types";

const MAX_EXTERNAL_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 50;
// IMAP folders that are intentionally not replicated.
const SKIPPED_FOLDERS = new Set(["\\drafts", "\\junk", "\\noselect", "\\nonexistent"]);

export interface ExternalSyncOptions {
  identity?: string;
  maxMessages?: number;
  deadlineMs?: number;
  openImap?: (host: string, port: number) => Promise<ImapTransport>;
}

export interface ExternalFolderReport {
  imapFolder: string;
  localFolder: string;
  lastUid: number;
  uidNext: number | null;
  synced: number;
  skipped: number;
  backfillDone: boolean;
  error?: string;
}

export interface ExternalAccountReport {
  identity: string;
  ok: boolean;
  folders: ExternalFolderReport[];
  error?: string;
}

export interface ExternalSyncReport {
  accounts: ExternalAccountReport[];
  done: boolean;
  syncedMessages: number;
  skippedMessages: number;
}

export async function loadExternalAccount(env: Env, identity: string): Promise<ExternalAccountRow | null> {
  return env.DB.prepare(`SELECT ea.* FROM external_accounts ea JOIN identities i ON i.address = ea.identity_address
    WHERE ea.identity_address = ? AND ea.enabled = 1 AND i.enabled = 1`).bind(identity).first<ExternalAccountRow>();
}

export function externalPassword(env: Env, account: ExternalAccountRow): string {
  const password = (env as unknown as Record<string, string | undefined>)[account.password_secret];
  if (!password) throw new Error(`Worker secret ${account.password_secret} is not configured`);
  return password;
}

export async function runExternalSync(env: Env, options: ExternalSyncOptions = {}): Promise<ExternalSyncReport> {
  const deadline = Date.now() + (options.deadlineMs ?? 60_000);
  const budget = { remaining: Math.max(1, Math.min(options.maxMessages ?? 40, 200)) };
  const accountsResult = await env.DB.prepare(`SELECT ea.* FROM external_accounts ea
    JOIN identities i ON i.address = ea.identity_address
    WHERE ea.enabled = 1 AND i.enabled = 1 ${options.identity ? "AND ea.identity_address = ?" : ""}
    ORDER BY ea.identity_address`).bind(...(options.identity ? [options.identity] : [])).all<ExternalAccountRow>();
  const report: ExternalSyncReport = { accounts: [], done: true, syncedMessages: 0, skippedMessages: 0 };
  for (const account of accountsResult.results) {
    const accountReport = await syncAccount(env, account, budget, deadline, options.openImap ?? connectTlsTransport);
    report.accounts.push(accountReport);
    report.syncedMessages += accountReport.folders.reduce((total, folder) => total + folder.synced, 0);
    report.skippedMessages += accountReport.folders.reduce((total, folder) => total + folder.skipped, 0);
    if (!accountReport.ok || accountReport.folders.some((folder) => !folder.backfillDone)) report.done = false;
  }
  return report;
}

async function syncAccount(env: Env, account: ExternalAccountRow, budget: { remaining: number }, deadline: number,
  openImap: (host: string, port: number) => Promise<ImapTransport>): Promise<ExternalAccountReport> {
  const result: ExternalAccountReport = { identity: account.identity_address, ok: true, folders: [] };
  let client: ImapClient | null = null;
  try {
    const password = externalPassword(env, account);
    client = await ImapClient.open(await openImap(account.imap_host, account.imap_port));
    await client.login(account.username, password);
    await ensureFolderMappings(env, account, await client.listFolders());
    const states = await env.DB.prepare(`SELECT * FROM external_sync_state WHERE identity_address = ?
      ORDER BY CASE imap_folder WHEN 'INBOX' THEN 0 ELSE 1 END, imap_folder`)
      .bind(account.identity_address).all<ExternalSyncStateRow>();
    for (const state of states.results) {
      const folderReport = await syncFolder(env, account, client, state, budget, deadline);
      result.folders.push(folderReport);
      if (budget.remaining <= 0 || Date.now() >= deadline) break;
    }
  } catch (error) {
    result.ok = false;
    result.error = String(error).slice(0, 500);
    console.error(JSON.stringify({ event: "external-sync-failed", identity: account.identity_address, error: result.error }));
  } finally {
    await client?.logout().catch(() => undefined);
  }
  return result;
}

// New IMAP folders are discovered on every run: special-use flags map onto the
// local folder set, everything else replicates into 'archive' with its origin
// name preserved on each message row.
async function ensureFolderMappings(env: Env, account: ExternalAccountRow, folders: ImapFolder[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const folder of folders) {
    const local = mapImapFolder(folder);
    if (!local) continue;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO external_sync_state (identity_address, imap_folder, local_folder)
      VALUES (?, ?, ?)`).bind(account.identity_address, folder.name, local));
  }
  if (statements.length) await env.DB.batch(statements);
}

export function mapImapFolder(folder: ImapFolder): "inbox" | "sent" | "archive" | "trash" | null {
  const attributes = new Set(folder.attributes.map((attribute) => attribute.toLowerCase()));
  if ([...attributes].some((attribute) => SKIPPED_FOLDERS.has(attribute))) return null;
  const name = folder.name.toLowerCase();
  if (name === "drafts" || name === "junk" || name === "spam") return null;
  if (name === "inbox") return "inbox";
  if (attributes.has("\\sent") || name === "sent" || name === "sent items") return "sent";
  if (attributes.has("\\trash") || name === "trash" || name === "deleted items") return "trash";
  if (attributes.has("\\archive")) return "archive";
  return "archive";
}

async function syncFolder(env: Env, account: ExternalAccountRow, client: ImapClient, state: ExternalSyncStateRow,
  budget: { remaining: number }, deadline: number): Promise<ExternalFolderReport> {
  const report: ExternalFolderReport = { imapFolder: state.imap_folder, localFolder: state.local_folder,
    lastUid: state.last_uid, uidNext: null, synced: 0, skipped: 0, backfillDone: state.backfill_done === 1 };
  try {
    const mailbox = await client.examine(state.imap_folder);
    report.uidNext = mailbox.uidNext;
    let lastUid = state.last_uid;
    let backfillDone = state.backfill_done === 1;
    if (state.uidvalidity !== null && state.uidvalidity !== mailbox.uidValidity) {
      lastUid = 0;
      backfillDone = false;
    }
    const pending = mailbox.uidNext > lastUid + 1 ? await client.uidsAfter(lastUid) : [];
    let processedAll = true;
    for (const uid of pending) {
      if (budget.remaining <= 0 || Date.now() >= deadline) {
        processedAll = false;
        break;
      }
      budget.remaining -= 1;
      const ingested = await ingestOneUid(env, account, client, state, uid, backfillDone);
      lastUid = uid;
      if (ingested) report.synced += 1;
      else report.skipped += 1;
    }
    if (processedAll && !backfillDone) backfillDone = true;
    await env.DB.prepare(`UPDATE external_sync_state SET uidvalidity = ?, last_uid = ?, backfill_done = ?,
      synced_messages = synced_messages + ?, skipped_messages = skipped_messages + ?,
      last_synced_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE identity_address = ? AND imap_folder = ?`)
      .bind(mailbox.uidValidity, lastUid, backfillDone ? 1 : 0, report.synced, report.skipped,
        account.identity_address, state.imap_folder).run();
    report.lastUid = lastUid;
    report.backfillDone = backfillDone;
  } catch (error) {
    report.error = String(error).slice(0, 500);
    report.backfillDone = false;
    await env.DB.prepare(`UPDATE external_sync_state SET last_error = ?, last_synced_at = CURRENT_TIMESTAMP
      WHERE identity_address = ? AND imap_folder = ?`)
      .bind(report.error, account.identity_address, state.imap_folder).run();
  }
  return report;
}

async function ingestOneUid(env: Env, account: ExternalAccountRow, client: ImapClient, state: ExternalSyncStateRow,
  uid: number, backfillDone: boolean): Promise<boolean> {
  const fetched = await client.fetchMessage(uid);
  if (!fetched || fetched.raw.byteLength === 0 || fetched.raw.byteLength > MAX_EXTERNAL_BYTES) return false;
  const flags = new Set(fetched.flags.map((flag) => flag.toLowerCase()));
  const fallbackDate = parseInternalDate(fetched.internalDate) ?? new Date();
  return ingestExternalMessage(env, {
    identity: account.identity_address,
    localFolder: state.local_folder,
    externalFolder: state.imap_folder.toLowerCase() === state.local_folder ? null : state.imap_folder,
    raw: fetched.raw,
    seen: flags.has("\\seen"),
    flagged: flags.has("\\flagged"),
    fallbackReceivedAt: fallbackDate.toISOString(),
    // Push only for genuinely new inbox mail after the folder's backfill.
    suppressPush: !backfillDone,
  });
}

export interface ExternalIngestInput {
  identity: string;
  localFolder: "inbox" | "sent" | "archive" | "trash";
  externalFolder: string | null;
  raw: Uint8Array;
  seen: boolean;
  flagged: boolean;
  fallbackReceivedAt: string;
  suppressPush: boolean;
}

// Writes one fetched RFC822 message as a finalized local message row. Returns
// false when the message is already present (content digest or Message-ID).
export async function ingestExternalMessage(env: Env, input: ExternalIngestInput): Promise<boolean> {
  const rawBuffer = new ArrayBuffer(input.raw.byteLength);
  new Uint8Array(rawBuffer).set(input.raw);
  const digest = await sha256(rawBuffer);
  const id = await stableId(`${digest}:${input.identity}`);
  const existing = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
  if (existing) return false;

  const parsed = await new PostalMime().parse(rawBuffer);
  const parsedMessageId = cleanHeader(parsed.messageId, 998) || null;
  if (parsedMessageId) {
    const collision = await env.DB.prepare("SELECT id FROM messages WHERE message_id = ? LIMIT 1").bind(parsedMessageId).first();
    if (collision) return false;
  }
  const sender = normalizeAddresses(parsed.from)[0] ?? { address: input.identity };
  const recipients = normalizeAddresses(parsed.to);
  const cc = normalizeAddresses(parsed.cc);
  const parsedInReplyTo = cleanHeader(parsed.inReplyTo, 998) || null;
  const threadId = parsedInReplyTo
    ? await findThreadForReply(env, parsedInReplyTo, input.identity, parsedMessageId ?? id)
    : await stableId(parsedMessageId ?? id);
  const receivedAt = parsed.date && !Number.isNaN(new Date(parsed.date).valueOf())
    ? new Date(parsed.date).toISOString()
    : input.fallbackReceivedAt;
  const direction = input.localFolder === "sent" ? "outbound" : "inbound";
  const unread = direction === "inbound" && !input.seen ? 1 : 0;

  // New inbox mail goes through the autopilot before it is written, so the
  // push and the inbox already reflect the verdict. Backfilled history does not.
  const senderAddress = cleanHeader(sender.address, 254).toLowerCase();
  const before: MessageState = { folder: input.localFolder, unread, starred: input.flagged ? 1 : 0, spam: 0,
    senderAddress, identityAddress: input.identity };
  const plan = !input.suppressPush && direction === "inbound" && input.localFolder === "inbox"
    ? await planArrival(env, {
      messageId: id, senderName: cleanHeader(sender.name, 320), senderAddress,
      recipients: recipients.map((recipient) => recipient.address).join(", ") || input.identity,
      subject: cleanHeader(parsed.subject, 998), receivedAt, text: parsed.text ?? preview(parsed.text), identityAddress: input.identity,
    }, before, await isTrustedSender(env, senderAddress),
    { id, subject: cleanHeader(parsed.subject, 998), senderAddress, identityAddress: input.identity, receivedAt }).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "autopilot-arrival-failed", id, error: String(error).slice(0, 300) }));
      return null;
    })
    : null;
  const decision = plan?.decision ?? { ...before, actions: [], draft: false };
  const assignments = triageAssignments(plan?.triage ?? null);

  const rawKey = `raw/${id}.eml`;
  const textKey = parsed.text ? `body/${id}.txt` : null;
  const htmlKey = parsed.html ? `body/${id}.html` : null;
  await Promise.all([
    env.MAIL.put(rawKey, rawBuffer, { httpMetadata: { contentType: "message/rfc822" } }),
    ...(textKey ? [env.MAIL.put(textKey, parsed.text!, { httpMetadata: { contentType: "text/plain; charset=utf-8" } })] : []),
    ...(htmlKey ? [env.MAIL.put(htmlKey, parsed.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } })] : []),
  ]);
  const storedAttachments = await Promise.all(parsed.attachments.slice(0, MAX_ATTACHMENTS)
    .map((attachment, index) => prepareAttachment(env, id, attachment, index)));

  const insert = env.DB.prepare(`INSERT INTO messages
    (id, thread_id, message_id, in_reply_to, direction, folder, subject, sender_name, sender_address,
      recipients_json, cc_json, preview, text_key, html_key, raw_key, received_at, unread, starred,
      has_attachments, attachment_count, stored_attachment_count, size, status, identity_address, external_folder, spam)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`)
    .bind(id, threadId, parsedMessageId, parsedInReplyTo, direction, decision.folder,
      cleanHeader(parsed.subject, 998), cleanHeader(sender.name, 320), senderAddress,
      JSON.stringify(recipients.length ? recipients : [{ address: input.identity }]), JSON.stringify(cc), preview(parsed.text),
      textKey, htmlKey, rawKey, receivedAt, decision.unread, decision.starred,
      parsed.attachments.length ? 1 : 0, parsed.attachments.length, storedAttachments.length,
      input.raw.byteLength, input.identity, input.externalFolder, decision.spam);
  const statements: D1PreparedStatement[] = [insert, ...storedAttachments];
  if (plan) {
    statements.push(env.DB.prepare(`UPDATE messages SET ${assignments.sql} spam_model = ?, spam_checked_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(...assignments.bindings, plan.triage.model, id));
    statements.push(...actionLogStatements(env, id, decision, before), ...relatedStatements(env, plan.related));
  }
  const announce = !input.suppressPush && direction === "inbound" && decision.folder === "inbox" && !decision.spam && !plan?.quiet;
  if (!announce) {
    statements.push(env.DB.prepare("DELETE FROM push_notification_outbox WHERE message_id = ?").bind(id));
  }
  await env.DB.batch(statements);
  if (announce) await enqueuePushNotification(env, id);
  if (decision.draft) await enqueueDraft(env, id);
  return true;
}

export async function externalStatus(env: Env): Promise<Array<{
  identity: string; imapHost: string; smtpHost: string; enabled: boolean;
  folders: Array<{ imapFolder: string; localFolder: string; lastUid: number; backfillDone: boolean;
    synced: number; skipped: number; lastSyncedAt: string | null; lastError: string | null }>;
}>> {
  const accounts = await env.DB.prepare("SELECT * FROM external_accounts ORDER BY identity_address").all<ExternalAccountRow>();
  const states = await env.DB.prepare("SELECT * FROM external_sync_state ORDER BY identity_address, imap_folder").all<ExternalSyncStateRow>();
  return accounts.results.map((account) => ({
    identity: account.identity_address,
    imapHost: `${account.imap_host}:${account.imap_port}`,
    smtpHost: `${account.smtp_host}:${account.smtp_port}`,
    enabled: account.enabled === 1,
    folders: states.results.filter((state) => state.identity_address === account.identity_address).map((state) => ({
      imapFolder: state.imap_folder,
      localFolder: state.local_folder,
      lastUid: state.last_uid,
      backfillDone: state.backfill_done === 1,
      synced: state.synced_messages,
      skipped: state.skipped_messages,
      lastSyncedAt: state.last_synced_at,
      lastError: state.last_error,
    })),
  }));
}
