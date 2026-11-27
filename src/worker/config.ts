import type { Env } from "./types";

export const ROUTING_HOSTS = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
] as const;

export const MTA_STS_POLICY = [
  "version: STSv1",
  "mode: enforce",
  ...ROUTING_HOSTS.map((host) => `mx: ${host}`),
  "max_age: 604800",
  "",
].join("\n");

export function appName(env: Pick<Env, "APP_NAME">): string {
  return (env.APP_NAME ?? "").trim() || "lmail";
}

export function workerName(env: Partial<Pick<Env, "WORKER_NAME">>): string {
  return (env.WORKER_NAME ?? "").trim() || "lmail";
}

export function mailHost(env: Partial<Pick<Env, "MAIL_HOST">>): string {
  return (env.MAIL_HOST ?? "").trim().toLowerCase();
}

export function ownerName(env: Partial<Pick<Env, "OWNER_NAME">>): string {
  return (env.OWNER_NAME ?? "").trim() || "Owner";
}

export const DEFAULT_DRAFT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

export function draftModel(env: Partial<Pick<Env, "DRAFT_MODEL">>): string {
  const configured = (env.DRAFT_MODEL ?? "").trim();
  return configured || DEFAULT_DRAFT_MODEL;
}

export function ownerTimezone(env: Partial<Pick<Env, "OWNER_TIMEZONE">>): string {
  const tz = (env.OWNER_TIMEZONE ?? "").trim();
  return tz || "UTC";
}

export function accountId(env: Partial<Pick<Env, "CLOUDFLARE_ACCOUNT_ID">>): string {
  return (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
}

export function dmarcReportAddress(env: Partial<Pick<Env, "DMARC_REPORT_ADDRESS">>): string {
  return (env.DMARC_REPORT_ADDRESS ?? "").trim().toLowerCase();
}

export function tlsReportAddress(env: Partial<Pick<Env, "TLS_REPORT_ADDRESS">>): string {
  return (env.TLS_REPORT_ADDRESS ?? "").trim().toLowerCase();
}

export function agentSenderDomains(env: Partial<Pick<Env, "AGENT_SENDER_DOMAINS">>): string[] {
  return (env.AGENT_SENDER_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export function managedDomains(env: Partial<Pick<Env, "MANAGED_DOMAINS_JSON">>): Record<string, string> {
  const raw = (env.MANAGED_DOMAINS_JSON ?? "").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [domain, zoneId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof zoneId === "string" && domain.trim() && zoneId.trim()) {
        out[domain.trim().toLowerCase()] = zoneId.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function mtaStsHosts(env: Partial<Pick<Env, "MANAGED_DOMAINS_JSON">>): Set<string> {
  return new Set(Object.keys(managedDomains(env)).map((domain) => `mta-sts.${domain}`));
}
