// One send path for every identity: routed identities deliver through
// Cloudflare Email Sending, external identities submit through their
// account's SMTP server. Both share the durable send_requests bookkeeping.

import { sha256, stableId } from "./crypto";
import { externalPassword, loadExternalAccount } from "./external";
import { deliverOutbound, type OutboundExecutionResult } from "./outbound";
import { submitViaSmtp } from "./smtp";
import type { Env, ExternalAccountRow, MessageRow } from "./types";

export interface SendRequestInput {
  keyId: string;
  allowedIdentities: string[] | null;
  idempotencyKey: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  replyToMessageId?: string;
  attachments: Array<{ filename: string; contentType: string; data: string }>;
}

export type SendOutcome =
  | { kind: "error"; status: 403 | 404 | 409 | 413; message: string }
  | { kind: "result"; result: OutboundExecutionResult };

export async function performSend(env: Env, input: SendRequestInput): Promise<SendOutcome> {
  if (input.allowedIdentities !== null && !input.allowedIdentities.includes(input.from)) {
    return { kind: "error", status: 403, message: "Sender identity is outside this key's access policy" };
  }
  const identity = await env.DB.prepare("SELECT address, display_name, kind FROM identities WHERE address = ? AND enabled = 1")
    .bind(input.from).first<{ address: string; display_name: string; kind: "routed" | "external" }>();
  if (!identity) return { kind: "error", status: 403, message: "Sender identity is not enabled" };

  let reply: MessageRow | null = null;
  if (input.replyToMessageId) {
    const access = input.allowedIdentities === null
      ? { sql: "1 = 1", bindings: [] as string[] }
      : { sql: `identity_address IN (${input.allowedIdentities.map(() => "?").join(",") || "''"})`, bindings: input.allowedIdentities };
    reply = await env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
      .bind(input.replyToMessageId, ...access.bindings).first<MessageRow>();
    if (!reply) return { kind: "error", status: 404, message: "Reply target not found" };
    if (reply.identity_address !== input.from) return { kind: "error", status: 409, message: "Replies must use the original message identity" };
  }

  const { keyId, allowedIdentities, idempotencyKey, replyToMessageId, ...message } = input;
  void allowedIdentities;
  const requestHash = await sha256(JSON.stringify({ ...message, replyToMessageId }));
  const threadId = reply?.thread_id ?? await stableId(input.subject.replace(/^\s*(re|aw|fw|fwd)\s*:\s*/i, "").toLowerCase());
  const external = identity.kind === "external" ? await loadExternalAccount(env, input.from) : null;
  if (identity.kind === "external" && !external) {
    return { kind: "error", status: 403, message: "External account for this identity is not configured" };
  }

  try {
    const result = await deliverOutbound(env, {
      ...message,
      keyId,
      idempotencyKey,
      requestHash,
      threadId,
      replyToMessageId,
      fromName: identity.display_name,
      inReplyTo: reply?.message_id ?? undefined,
      references: reply?.message_id ? [reply.message_id] : undefined,
    }, external ? smtpSender(env, external) : undefined);
    return { kind: "result", result };
  } catch (error) {
    if (String(error).includes("Encoded message exceeds")) {
      return { kind: "error", status: 413, message: "Encoded message exceeds Cloudflare's 5 MiB limit" };
    }
    throw error;
  }
}

function smtpSender(env: Env, account: ExternalAccountRow) {
  const password = externalPassword(env, account);
  return async (_env: Env, from: string, recipient: string, raw: string): Promise<{ messageId: string | null }> => {
    const accepted = await submitViaSmtp({
      host: account.smtp_host,
      port: account.smtp_port,
      username: account.username,
      password,
      from,
      recipients: [recipient],
      raw,
    });
    return { messageId: accepted.messageId };
  };
}
