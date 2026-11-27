import type { Env } from "./types";

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  data: string;
}

export interface OutboundMessage {
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: OutboundAttachment[];
}

export interface OutboundRecipient {
  address: string;
  kind: "to" | "cc" | "bcc";
}

export interface PreparedEmail {
  raw: string;
  messageId: string;
  encodedBytes: number;
  recipients: OutboundRecipient[];
}

function encodeHeader(value: string, fold = true): string {
  const clean = value.replaceAll(/[\r\n\0]/g, " ");
  if (/^[\x20-\x7E]*$/.test(clean)) {
    if (!fold || clean.length <= 78) return clean;
  }
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of clean) {
    const charBytes = encoder.encode(char).byteLength;
    if (fold && chunkBytes > 0 && chunkBytes + charBytes > 45) {
      words.push(encodedWord(encoder.encode(chunk)));
      chunk = char;
      chunkBytes = charBytes;
    } else {
      chunk += char;
      chunkBytes += charBytes;
    }
  }
  if (chunk.length > 0 || words.length === 0) {
    words.push(encodedWord(encoder.encode(chunk)));
  }
  return words.join("\r\n ");
}

function encodedWord(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function base64Lines(value: string): string {
  return value.replaceAll(/\s/g, "").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function textBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return base64Lines(btoa(binary));
}

function headerAddress(address: string): string {
  return address.replaceAll(/[\r\n,]/g, "").trim();
}

function encodedDisplayName(value: string): string {
  const clean = value.replaceAll(/[\r\n\0]/g, " ").trim();
  const bytes = new TextEncoder().encode(clean);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function mailbox(address: string, displayName: string | undefined): string {
  return displayName?.trim() ? `${encodedDisplayName(displayName)} <${headerAddress(address)}>` : headerAddress(address);
}

function mimeParameter(value: string): string {
  return encodeHeader(value.replaceAll(/["\\]/g, "_"), false);
}

export function buildMime(from: string, input: Omit<OutboundMessage, "from"> | OutboundMessage): { raw: string; messageId: string } {
  const mixedBoundary = `mixed_${crypto.randomUUID().replaceAll("-", "")}`;
  const alternativeBoundary = `alt_${crypto.randomUUID().replaceAll("-", "")}`;
  const messageId = `<${crypto.randomUUID()}@${from.split("@")[1]}>`;
  const headers = [
    `From: ${mailbox(from, input.fromName)}`,
    `To: ${input.to.map(headerAddress).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(headerAddress).join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo.replaceAll(/[\r\n]/g, "")}`] : []),
    ...(input.references?.length ? [`References: ${input.references.join(" ").replaceAll(/[\r\n]/g, "")}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ];

  const parts = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    textBase64(input.text),
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    textBase64(input.html ?? `<div style="white-space:pre-wrap">${escapeHtml(input.text)}</div>`),
    `--${alternativeBoundary}--`,
  ];

  for (const attachment of input.attachments) {
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType.replaceAll(/[\r\n"]/g, "")}; name="${mimeParameter(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${mimeParameter(attachment.filename)}"`,
      "",
      base64Lines(attachment.data),
    );
  }
  parts.push(`--${mixedBoundary}--`, "");
  return { raw: `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, messageId };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function prepareEmail(input: OutboundMessage): PreparedEmail {
  const recipients = uniqueRecipients(input);
  if (recipients.length > 20) throw new Error("At most 20 recipients are allowed.");
  const to = recipients.filter((item) => item.kind === "to").map((item) => item.address);
  const cc = recipients.filter((item) => item.kind === "cc").map((item) => item.address);
  const bcc = recipients.filter((item) => item.kind === "bcc").map((item) => item.address);
  const built = buildMime(input.from, { ...input, to, cc, bcc });
  const encodedBytes = new TextEncoder().encode(built.raw).byteLength;
  if (encodedBytes > 5 * 1024 * 1024) throw new Error("Encoded message exceeds Cloudflare's 5 MiB limit.");
  return { ...built, encodedBytes, recipients };
}

export async function sendPreparedEmail(env: Env, from: string, recipient: string, raw: string): Promise<EmailSendResult> {
  const { EmailMessage } = await import("cloudflare:email");
  return env.EMAIL.send(new EmailMessage(from, recipient, raw));
}

export async function sendEmail(env: Env, input: OutboundMessage): Promise<PreparedEmail> {
  const prepared = prepareEmail(input);
  await Promise.all(prepared.recipients.map((recipient) => sendPreparedEmail(env, input.from, recipient.address, prepared.raw)));
  return prepared;
}

function uniqueRecipients(input: Pick<OutboundMessage, "to" | "cc" | "bcc">): OutboundRecipient[] {
  const selected = new Map<string, OutboundRecipient>();
  for (const [kind, addresses] of [["to", input.to], ["cc", input.cc], ["bcc", input.bcc]] as const) {
    for (const address of addresses) {
      const normalized = address.toLowerCase();
      if (!selected.has(normalized)) selected.set(normalized, { address: normalized, kind });
    }
  }
  return [...selected.values()];
}
