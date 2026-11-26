// Spam support shared by the triage paths. The verdict itself comes from the
// triage models (triage.ts); this file holds what is decided without them.
//
// The verdict only hides mail. Nothing is rejected or deleted, so a false
// positive costs a trip to the spam folder, never a lost message.

import type { Env } from "./types";

/**
 * Senders that are never spam, whatever the models say: the owner's own
 * identities, and anyone in the contacts table — an address he has written to
 * himself. A model cannot tell his father's one-line mail from a stranger's
 * cold open, and the first classifier got exactly that wrong in production,
 * so correspondents are decided by the mailbox's own history.
 */
export const TRUSTED_SENDER_SQL = `(EXISTS (SELECT 1 FROM identities i WHERE i.address = ?1)
  OR EXISTS (SELECT 1 FROM contacts c WHERE c.address = ?1))`;

export async function isTrustedSender(env: Env, senderAddress: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${TRUSTED_SENDER_SQL} AS trusted`).bind(senderAddress).first<{ trusted: number }>();
  return Boolean(row?.trusted);
}

// Workers AI returns two response shapes: the older text-generation models
// answer with { response }, the newer ones with an OpenAI-style choices array.
export function readModelText(response: unknown): string {
  if (typeof response !== "object" || response === null) return "";
  const record = response as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  if (record.response !== undefined && record.response !== null) return String(record.response);
  const content = record.choices?.[0]?.message?.content;
  return content === undefined || content === null ? "" : String(content);
}
