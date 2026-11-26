import { agentSenderDomains, ownerName } from "./config";
import type { Env } from "./types";

// Env-driven owner profile, writing style, and per-identity signatures.
// Configure OWNER_PROFILE, OWNER_STYLE_GUIDE, and IDENTITY_SIGNATURES_JSON
// in wrangler.jsonc vars (or Cloudflare Worker environment variables).

export function ownerProfile(env: Partial<Pick<Env, "OWNER_PROFILE" | "OWNER_NAME" | "OWNER_EMAIL" | "AGENT_SENDER_DOMAINS">>): string {
  const configured = (env.OWNER_PROFILE ?? "").trim();
  if (configured) return configured;
  const name = ownerName(env);
  const email = (env.OWNER_EMAIL ?? "").trim();
  const agentDomains = agentSenderDomains(env);
  const base = email ? `Mailbox of ${name} (${email}).` : `Mailbox of ${name}.`;
  const agents = agentDomains.length > 0
    ? ` Automated reports from the owner's own AI agents may arrive from ${agentDomains.join(", ")}.`
    : "";
  return `${base}${agents}`;
}

export function styleGuide(env: Partial<Pick<Env, "OWNER_STYLE_GUIDE" | "OWNER_NAME">>): string {
  const configured = (env.OWNER_STYLE_GUIDE ?? "").trim();
  if (configured) return configured;
  const name = ownerName(env);
  return `How ${name} writes:
- Language: answer in the language of the incoming mail. With someone they wrote to before, keep the language and form of address used with them.
- Short and direct, usually 1-5 sentences. No filler, no repeating the question back.
- Match the formality of the sender and sign off naturally as ${name}.
- Never invent facts, dates, decisions or attachments. Where only ${name} knows the answer, write a placeholder in square brackets, e.g. [confirm time] or [attach file].`;
}

export function replyStyle(env: Partial<Pick<Env, "OWNER_STYLE_GUIDE" | "OWNER_NAME">>): string {
  const name = ownerName(env);
  return `You write email replies as ${name}.
Write ONLY the body of the reply: no subject line, no quoted original, no explanation before or after it.

${styleGuide(env)}`;
}

export function identitySignatures(env: Partial<Pick<Env, "IDENTITY_SIGNATURES_JSON">>): Record<string, string> {
  const raw = (env.IDENTITY_SIGNATURES_JSON ?? "").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && key.trim() && value.trim()) {
        out[key.trim().toLowerCase()] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Appends a configured signature for an identity (by exact address or domain) if not already present. */
export function signedForIdentity(
  env: Partial<Pick<Env, "IDENTITY_SIGNATURES_JSON">>,
  identity: string,
  body: string,
): string {
  const signatures = identitySignatures(env);
  const normalized = identity.toLowerCase();
  const domain = normalized.split("@")[1] ?? "";
  const signature = signatures[normalized] ?? (domain ? signatures[domain] : undefined);
  if (!signature) return body;
  const trimmed = signature.trim();
  if (!trimmed || body.includes(trimmed)) return body;
  return `${body.trimEnd()}\n\n${trimmed}`;
}
