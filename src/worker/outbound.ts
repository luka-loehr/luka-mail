import { stableId } from "./crypto";
import { prepareEmail, sendPreparedEmail, type OutboundMessage, type OutboundRecipient } from "./mime";
import type { Env, SendRequestRow, SendRequestStatus, SendRecipientRow } from "./types";

export interface DurableOutboundInput extends OutboundMessage {
  keyId: string;
  idempotencyKey: string;
  requestHash: string;
  threadId: string;
  replyToMessageId?: string;
}

export interface OutboundResponse {
  sent: boolean;
  status: SendRequestStatus;
  error?: string;
  id: string;
  messageId: string;
  recipients: Array<{
    address: string;
    kind: OutboundRecipient["kind"];
    status: SendRecipientRow["status"];
    providerMessageId: string | null;
  }>;
}

export interface OutboundExecutionResult {
  statusCode: 200 | 201 | 409 | 502;
  response: OutboundResponse | { error: string; status: SendRequestStatus; previous?: OutboundResponse };
}

export type OutboundSender = (env: Env, from: string, recipient: string, raw: string) => Promise<{ messageId: string | null }>;

const providerSend: OutboundSender = async (env, from, recipient, raw) => {
  const result = await sendPreparedEmail(env, from, recipient, raw);
  return { messageId: result.messageId ?? null };
};

export async function deliverOutbound(env: Env, input: DurableOutboundInput, send: OutboundSender = providerSend): Promise<OutboundExecutionResult> {
  const prepared = prepareEmail(input);
  const messageRowId = crypto.randomUUID();
  const reservation = await env.DB.prepare(`INSERT OR IGNORE INTO send_requests
    (key_id, idempotency_key, request_hash, message_id, message_row_id, status)
    VALUES (?, ?, ?, ?, ?, 'reserved')`)
    .bind(input.keyId, input.idempotencyKey, input.requestHash, prepared.messageId, messageRowId).run();
  if (!reservation.meta.changes) return existingRequest(env, input);

  try {
    await stageOutbound(env, input, prepared, messageRowId);
  } catch (error) {
    await env.DB.prepare("DELETE FROM send_requests WHERE key_id = ? AND idempotency_key = ?")
      .bind(input.keyId, input.idempotencyKey).run();
    throw error;
  }

  const outcomes: OutboundResponse["recipients"] = [];
  for (const recipient of prepared.recipients) {
    await env.DB.prepare(`UPDATE send_recipients SET status = 'sending', attempts = attempts + 1,
      error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE key_id = ? AND idempotency_key = ? AND recipient = ?`)
      .bind(input.keyId, input.idempotencyKey, recipient.address).run();
    try {
      const result = await send(env, input.from, recipient.address, prepared.raw);
      await env.DB.prepare(`UPDATE send_recipients SET status = 'sent', provider_message_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE key_id = ? AND idempotency_key = ? AND recipient = ?`)
        .bind(result.messageId, input.keyId, input.idempotencyKey, recipient.address).run();
      outcomes.push({ address: recipient.address, kind: recipient.kind, status: "sent", providerMessageId: result.messageId });
    } catch (error) {
      const suppressed = String(error).toLowerCase().includes("suppressed");
      const status = suppressed ? "failed" : "unknown";
      const message = suppressed ? "Recipient is suppressed by the outbound provider" : "Provider acceptance is unknown";
      await env.DB.prepare(`UPDATE send_recipients SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE key_id = ? AND idempotency_key = ? AND recipient = ?`)
        .bind(status, message, input.keyId, input.idempotencyKey, recipient.address).run();
      outcomes.push({ address: recipient.address, kind: recipient.kind, status, providerMessageId: null });
    }
  }

  const sentCount = outcomes.filter((item) => item.status === "sent").length;
  const unknownCount = outcomes.filter((item) => item.status === "unknown").length;
  const finalStatus: SendRequestStatus = sentCount === outcomes.length
    ? "complete"
    : sentCount > 0
      ? "partial"
      : unknownCount > 0
        ? "unknown"
        : "failed";
  const errorMessage = finalStatus === "complete" ? null : outboundSummary(outcomes);
  const response: OutboundResponse = {
    sent: finalStatus === "complete",
    status: finalStatus,
    ...(errorMessage ? { error: `Outbound delivery was not complete (${errorMessage})` } : {}),
    id: messageRowId,
    messageId: prepared.messageId,
    recipients: outcomes,
  };
  const contactStatements = outcomes.filter((item) => item.status === "sent").map((item) => env.DB.prepare(`INSERT INTO contacts
    (identity_address, address, display_name, source, send_count, first_sent_at, last_sent_at)
    VALUES (?, ?, COALESCE((
      SELECT NULLIF(trim(sender_name), '') FROM messages
      WHERE direction = 'inbound' AND lower(sender_address) = ? AND sender_name != ''
      ORDER BY received_at DESC LIMIT 1
    ), ''), 'learned', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(identity_address, address) DO UPDATE SET
      display_name = CASE WHEN contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
      send_count = contacts.send_count + 1,
      first_sent_at = COALESCE(contacts.first_sent_at, excluded.first_sent_at),
      last_sent_at = excluded.last_sent_at,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(input.from, item.address, item.address));
  await env.DB.batch([
    env.DB.prepare("UPDATE messages SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(sentCount > 0 ? "ready" : "failed", messageRowId),
    env.DB.prepare(`UPDATE send_requests SET status = ?, response_json = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE key_id = ? AND idempotency_key = ?`)
      .bind(finalStatus, JSON.stringify(response), errorMessage, input.keyId, input.idempotencyKey),
    ...contactStatements,
  ]);
  if (sentCount > 0 && input.replyToMessageId) {
    await env.DB.prepare("DELETE FROM drafts WHERE reply_to_message_id = ? AND identity_address = ?")
      .bind(input.replyToMessageId, input.from).run();
  }
  return { statusCode: finalStatus === "complete" ? 201 : 502, response };
}

async function stageOutbound(env: Env, input: DurableOutboundInput, prepared: ReturnType<typeof prepareEmail>, messageRowId: string): Promise<void> {
  const rawKey = `raw/${messageRowId}.eml`;
  const textKey = `body/${messageRowId}.txt`;
  const htmlKey = `body/${messageRowId}.html`;
  const html = input.html ?? `<div style="white-space:pre-wrap">${escapeHtml(input.text)}</div>`;
  await Promise.all([
    env.MAIL.put(rawKey, prepared.raw, { httpMetadata: { contentType: "message/rfc822" } }),
    env.MAIL.put(textKey, input.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }),
    env.MAIL.put(htmlKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
  ]);

  const attachmentStatements = await Promise.all(input.attachments.map(async (attachment, index) => {
    const attachmentId = await stableId(`${messageRowId}:${index}:${attachment.filename}`);
    const objectKey = `attachment/${messageRowId}/${attachmentId}`;
    const bytes = Uint8Array.from(atob(attachment.data), (char) => char.charCodeAt(0));
    await env.MAIL.put(objectKey, bytes, { httpMetadata: { contentType: attachment.contentType } });
    return env.DB.prepare(`INSERT INTO attachments
      (id, message_id, filename, content_type, object_key, size) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(attachmentId, messageRowId, attachment.filename, attachment.contentType, objectKey, bytes.byteLength);
  }));
  const receivedAt = new Date().toISOString();
  const messageStatement = env.DB.prepare(`INSERT INTO messages
    (id, thread_id, message_id, in_reply_to, direction, folder, subject, sender_name, sender_address,
      recipients_json, cc_json, preview, text_key, html_key, raw_key, received_at, unread, has_attachments,
      attachment_count, stored_attachment_count, size, status, identity_address)
    VALUES (?, ?, ?, ?, 'outbound', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', ?)`)
    .bind(messageRowId, input.threadId, prepared.messageId, input.inReplyTo ?? null, input.subject, input.fromName ?? "", input.from,
      JSON.stringify(prepared.recipients.filter((recipient) => recipient.kind === "to").map((recipient) => ({ address: recipient.address }))),
      JSON.stringify(prepared.recipients.filter((recipient) => recipient.kind === "cc").map((recipient) => ({ address: recipient.address }))),
      input.text.replaceAll(/\s+/g, " ").slice(0, 240), textKey, htmlKey,
      rawKey, receivedAt, input.attachments.length ? 1 : 0, input.attachments.length, input.attachments.length,
      prepared.encodedBytes, input.from);
  const recipientStatements = prepared.recipients.map((recipient) => env.DB.prepare(`INSERT INTO send_recipients
    (key_id, idempotency_key, recipient, kind) VALUES (?, ?, ?, ?)`)
    .bind(input.keyId, input.idempotencyKey, recipient.address, recipient.kind));
  await env.DB.batch([
    messageStatement,
    ...attachmentStatements,
    ...recipientStatements,
    env.DB.prepare(`UPDATE send_requests SET status = 'sending', updated_at = CURRENT_TIMESTAMP
      WHERE key_id = ? AND idempotency_key = ?`).bind(input.keyId, input.idempotencyKey),
  ]);
}

async function existingRequest(env: Env, input: DurableOutboundInput): Promise<OutboundExecutionResult> {
  const existing = await env.DB.prepare("SELECT * FROM send_requests WHERE key_id = ? AND idempotency_key = ?")
    .bind(input.keyId, input.idempotencyKey).first<SendRequestRow>();
  if (!existing) return { statusCode: 409, response: { error: "Send reservation disappeared", status: "unknown" } };
  if (!existing.request_hash || existing.request_hash !== input.requestHash) {
    return { statusCode: 409, response: { error: "Idempotency key was already used for a different request", status: existing.status } };
  }
  const previous = parseResponse(existing.response_json);
  if (existing.status === "complete" && previous) return { statusCode: 200, response: previous };
  return { statusCode: 409, response: {
    error: existing.status === "processing" || existing.status === "reserved" || existing.status === "sending"
      ? "Send is already in progress; do not retry with a new idempotency key"
      : "Send has a terminal non-success outcome; inspect recipient state before retrying",
    status: existing.status,
    ...(previous ? { previous } : {}),
  } };
}

function parseResponse(value: string | null): OutboundResponse | null {
  if (!value) return null;
  try { return JSON.parse(value) as OutboundResponse; } catch { return null; }
}

function outboundSummary(recipients: OutboundResponse["recipients"]): string {
  const counts = { sent: 0, failed: 0, unknown: 0 };
  for (const recipient of recipients) {
    if (recipient.status === "sent") counts.sent += 1;
    else if (recipient.status === "failed") counts.failed += 1;
    else counts.unknown += 1;
  }
  return `sent=${counts.sent}, failed=${counts.failed}, unknown=${counts.unknown}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
