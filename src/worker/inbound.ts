import PostalMime, { type Address, type Attachment, type Email } from "postal-mime";
import { senderPassedDmarc, senderPassedMailAuth } from "./bimi";
import { sha256, stableId } from "./crypto";
import { actionLogStatements, enqueueDraft, planArrival, relatedStatements, triageAssignments, type MessageState } from "./autopilot";
import { enqueuePushNotification } from "./push";
import { isTrustedSender } from "./spam";
import type { AddressValue, Env, InboundJob } from "./types";

const MAX_INBOUND_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 50;

export function cleanHeader(value: string | undefined, maximum: number): string {
  return (value ?? "").replaceAll(/[\r\n\0]/g, " ").trim().slice(0, maximum);
}

export function normalizeAddresses(input: Address | Address[] | undefined): AddressValue[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values.flatMap((value) => {
    if ("group" in value && Array.isArray(value.group)) return value.group.map((item) => ({ name: cleanHeader(item.name, 320), address: cleanHeader(item.address, 254).toLowerCase() }));
    return "address" in value && value.address ? [{ name: cleanHeader(value.name, 320), address: cleanHeader(value.address, 254).toLowerCase() }] : [];
  }).slice(0, 100);
}

export function preview(text = ""): string {
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 240);
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (typeof attachment.content === "string") {
    const binary = atob(attachment.content);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return new Uint8Array(attachment.content);
}

function addressOrEnvelope(parsed: Email, fallback: string): AddressValue {
  const from = normalizeAddresses(parsed.from)[0];
  return from ?? { address: fallback };
}

export async function acceptInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject("Message exceeds the 10 MiB receiving limit");
    return;
  }
  const identity = await env.DB.prepare("SELECT address FROM identities WHERE address = ? AND enabled = 1")
    .bind(message.to.toLowerCase()).first<{ address: string }>();
  if (!identity) {
    message.setReject("Unknown recipient");
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > MAX_INBOUND_BYTES) {
    message.setReject("Message exceeds the 10 MiB receiving limit");
    return;
  }
  const rawDigest = await sha256(raw);
  const id = await stableId(`${rawDigest}:${identity.address}`);
  const rawKey = `raw/${id}.eml`;
  const receivedAt = new Date().toISOString();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO messages
    (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
    VALUES (?, ?, 'inbound', 'inbox', ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, id, cleanHeader(message.from, 254), JSON.stringify([{ address: identity.address }]), rawKey, receivedAt, raw.byteLength, identity.address).run();
  if (!inserted.meta.changes) {
    const existing = await env.DB.prepare("SELECT status FROM messages WHERE id = ?").bind(id).first<{ status: string }>();
    if (existing?.status === "ready") return;
    await env.DB.prepare("UPDATE messages SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  }
  await env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
  await env.MAIL_QUEUE.send({ id, rawKey, envelopeFrom: message.from, envelopeTo: identity.address, receivedAt, size: raw.byteLength });
}

export async function processInbound(job: InboundJob, env: Env): Promise<void> {
  const identityAddress = job.envelopeTo.toLowerCase();
  const current = await env.DB.prepare("SELECT status, spam, folder, unread, starred FROM messages WHERE id = ?").bind(job.id)
    .first<{ status: string; spam: number; folder: MessageState["folder"]; unread: number; starred: number }>();
  if (!current) throw new Error(`Message ${job.id} is missing`);
  if (current.status === "ready") {
    if (!current.spam) await enqueuePushNotification(env, job.id);
    return;
  }
  await env.DB.prepare("UPDATE messages SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.id).run();
  const object = await env.MAIL.get(job.rawKey);
  if (!object) throw new Error(`Raw message ${job.rawKey} is missing`);
  const raw = await object.arrayBuffer();
  const parsed = await new PostalMime().parse(raw);
  const sender = addressOrEnvelope(parsed, job.envelopeFrom);
  const senderDomain = sender.address.split("@").at(-1)?.toLowerCase() ?? "";
  const authHeaders = parsed.headers.filter((header) => header.key === "authentication-results").map((header) => header.value);
  const senderAuthenticated = Boolean(senderDomain && senderPassedDmarc(authHeaders, senderDomain));
  const senderMailAuthenticated = Boolean(senderDomain && senderPassedMailAuth(authHeaders, senderDomain, job.envelopeFrom));
  const recipients = normalizeAddresses(parsed.to);
  const cc = normalizeAddresses(parsed.cc);
  const textKey = parsed.text ? `body/${job.id}.txt` : null;
  const htmlKey = parsed.html ? `body/${job.id}.html` : null;
  await Promise.all([
    ...(textKey ? [env.MAIL.put(textKey, parsed.text!, { httpMetadata: { contentType: "text/plain; charset=utf-8" } })] : []),
    ...(htmlKey ? [env.MAIL.put(htmlKey, parsed.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } })] : []),
  ]);

  const parsedMessageId = cleanHeader(parsed.messageId, 998) || null;
  const parsedInReplyTo = cleanHeader(parsed.inReplyTo, 998) || null;
  const messageIdCollision = parsedMessageId
    ? await env.DB.prepare("SELECT id FROM messages WHERE identity_address = ? AND message_id = ? AND id != ? LIMIT 1")
      .bind(identityAddress, parsedMessageId, job.id).first()
    : null;
  const storedMessageId = messageIdCollision ? null : parsedMessageId;
  const threadId = parsedInReplyTo
    ? await findThreadForReply(env, parsedInReplyTo, identityAddress, storedMessageId ?? job.id)
    : await stableId(storedMessageId ?? job.id);
  const receivedAt = parsed.date && !Number.isNaN(new Date(parsed.date).valueOf()) ? new Date(parsed.date).toISOString() : job.receivedAt;

  const storedAttachments = await Promise.all(parsed.attachments.slice(0, MAX_ATTACHMENTS)
    .map((attachment, index) => prepareAttachment(env, job.id, attachment, index)));
  const subject = cleanHeader(parsed.subject, 998);
  const senderAddress = cleanHeader(sender.address, 254).toLowerCase();
  const senderName = cleanHeader(sender.name, 320);
  const bodyPreview = preview(parsed.text);
  const before: MessageState = { folder: current.folder, unread: current.unread, starred: current.starred, spam: 0,
    senderAddress, identityAddress };
  const trusted = senderMailAuthenticated && await isTrustedSender(env, senderAddress, identityAddress);
  // A triage outage never holds up delivery: the message lands untriaged and
  // the cron sweep classifies it later.
  const plan = await planArrival(env, {
    messageId: job.id, senderName, senderAddress, recipients: recipients.map((recipient) => recipient.address).join(", ") || identityAddress,
    subject, receivedAt, text: parsed.text ?? bodyPreview, identityAddress,
  }, before, trusted, { id: job.id, subject, senderAddress, identityAddress, receivedAt, senderAuthenticated: senderMailAuthenticated }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "autopilot-arrival-failed", id: job.id, error: String(error).slice(0, 300) }));
    return null;
  });
  const decision = plan?.decision ?? { ...before, actions: [], draft: false };
  const assignments = triageAssignments(plan?.triage ?? null);
  const announce = !decision.spam && decision.folder === "inbox" && !plan?.quiet;

  const finalUpdate = env.DB.prepare(`UPDATE messages SET ${assignments.sql}
    thread_id = ?, message_id = ?, in_reply_to = ?, subject = ?, sender_name = ?, sender_address = ?,
    recipients_json = ?, cc_json = ?, preview = ?, text_key = ?, html_key = ?, received_at = ?,
    has_attachments = ?, attachment_count = ?, stored_attachment_count = ?, sender_authenticated = ?,
    folder = ?, unread = ?, starred = ?, spam = ?, spam_model = ?, spam_checked_at = ?, status = 'ready', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .bind(...assignments.bindings, threadId, storedMessageId, parsedInReplyTo, subject, senderName, senderAddress,
      JSON.stringify(recipients.length ? recipients : [{ address: identityAddress }]), JSON.stringify(cc), bodyPreview,
      textKey, htmlKey, receivedAt, parsed.attachments.length ? 1 : 0, parsed.attachments.length, storedAttachments.length,
      (senderAuthenticated || senderMailAuthenticated) ? 1 : 0, decision.folder, decision.unread, decision.starred, decision.spam,
      plan?.triage.model ?? null, plan ? new Date().toISOString() : null, job.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(job.id),
    env.DB.prepare("DELETE FROM autopilot_actions WHERE message_id = ?").bind(job.id),
    ...storedAttachments,
    finalUpdate,
    ...actionLogStatements(env, job.id, decision, before),
    ...relatedStatements(env, plan?.related ?? []),
    // The ready trigger queued a push; filed-away mail and repeated alerts are not announced.
    ...(announce ? [] : [env.DB.prepare("DELETE FROM push_notification_outbox WHERE message_id = ?").bind(job.id)]),
  ]);
  // Spam is stored, not announced; mail the autopilot filed away is in the brief.
  if (announce) await enqueuePushNotification(env, job.id);
  if (decision.draft) await enqueueDraft(env, job.id);
}

export async function findThreadForReply(env: Env, inReplyTo: string, identity: string, fallbackId: string): Promise<string> {
  const reply = await env.DB.prepare("SELECT thread_id FROM messages WHERE message_id = ? AND identity_address = ? LIMIT 1")
    .bind(inReplyTo, identity.toLowerCase()).first<{ thread_id: string }>();
  return reply?.thread_id ?? stableId(fallbackId);
}

export async function prepareAttachment(env: Env, messageId: string, attachment: Attachment, index: number): Promise<D1PreparedStatement> {
  const id = await stableId(`${messageId}:${index}:${attachment.filename ?? "attachment"}`);
  const objectKey = `attachment/${messageId}/${id}`;
  const bytes = attachmentBytes(attachment);
  await env.MAIL.put(objectKey, bytes, { httpMetadata: { contentType: attachment.mimeType ?? "application/octet-stream" } });
  return env.DB.prepare(`INSERT INTO attachments
    (id, message_id, filename, content_type, content_id, object_key, size, disposition)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, messageId, cleanHeader(attachment.filename ?? "Anhang", 255), cleanHeader(attachment.mimeType ?? "application/octet-stream", 127),
      cleanHeader(attachment.contentId, 998) || null, objectKey, bytes.byteLength, cleanHeader(attachment.disposition ?? "attachment", 32));
}
