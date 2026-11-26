import { accountId, managedDomains, ROUTING_HOSTS } from "./config";
import type { Env } from "./types";

export type ManagedDomain = { zoneId: string; newlyManaged: boolean; steps: string[] };

// Onboarding a domain needs more than the everyday token may do (zone
// lookup, Email Routing DNS), so it has its own secret: CLOUDFLARE_DOMAIN_TOKEN
// with Zone Read, DNS Write, Zone Settings Write and Email Routing Rules Write
// on the account's zones.
type CloudflareEnvelope<T> = { success: boolean; result: T; errors?: Array<{ message: string }> };

async function cloudflare<T>(env: Env, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_DOMAIN_TOKEN ?? env.CLOUDFLARE_API_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json<CloudflareEnvelope<T>>();
  if (!response.ok || !payload.success) throw new Error(payload.errors?.map((item) => item.message).join(", ") || `HTTP ${response.status}`);
  return payload.result;
}

/** Every domain addresses can be created on right now: the fixed list plus the ones added at run time. */
export async function listManagedDomains(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT domain FROM managed_domains ORDER BY domain").all<{ domain: string }>();
  return [...new Set([...Object.keys(managedDomains(env)), ...rows.results.map((row) => row.domain)])];
}

/** The zone a domain belongs to: first from what is already managed (no API call), then from the account's zones. */
async function findZone(env: Env, domain: string): Promise<{ id: string; name: string } | null> {
  const labels = domain.split(".");
  const candidates = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
  const known = new Map<string, string>(Object.entries(managedDomains(env)));
  const rows = await env.DB.prepare("SELECT domain, zone_id FROM managed_domains").all<{ domain: string; zone_id: string }>();
  for (const row of rows.results) known.set(row.domain, row.zone_id);
  for (const candidate of candidates) {
    const zoneId = known.get(candidate);
    if (zoneId) return { id: zoneId, name: candidate };
  }
  const acct = accountId(env);
  const accountParam = acct ? `&account.id=${encodeURIComponent(acct)}` : "";
  for (const candidate of candidates) {
    const zones = await cloudflare<Array<{ id: string; name: string }>>(env,
      `/zones?name=${encodeURIComponent(candidate)}${accountParam}&per_page=1`).catch(() => []);
    if (zones[0]) return zones[0];
  }
  // A subdomain of a zone that is known only through one of its other subdomains (aws.example.com -> example.com).
  for (const [managed, zoneId] of known) {
    const managedLabels = managed.split(".");
    for (let index = 1; index < managedLabels.length - 1; index += 1) {
      const parent = managedLabels.slice(index).join(".");
      if (candidates.includes(parent)) return { id: zoneId, name: parent };
    }
  }
  return null;
}

async function publicMx(domain: string): Promise<string[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
    headers: { Accept: "application/dns-json" },
  });
  if (!response.ok) return [];
  const payload = await response.json<{ Answer?: Array<{ data: string }> }>();
  return (payload.Answer ?? []).map((answer) => answer.data.split(" ").pop()?.replace(/\.$/, "").toLowerCase() ?? "");
}

/**
 * Takes a domain under management so addresses can be created on it: finds
 * its zone in the account and turns on Email Routing for exactly that name
 * (apex or subdomain), which publishes the MX and SPF records. Idempotent.
 */
export async function ensureManagedDomain(env: Env, domain: string): Promise<ManagedDomain> {
  const fixed = managedDomains(env)[domain];
  if (fixed) return { zoneId: fixed, newlyManaged: false, steps: [] };
  const row = await env.DB.prepare("SELECT zone_id FROM managed_domains WHERE domain = ?").bind(domain).first<{ zone_id: string }>();
  if (row) return { zoneId: row.zone_id, newlyManaged: false, steps: [] };
  const zone = await findZone(env, domain);
  if (!zone) throw new Error(`no zone in this Cloudflare account covers ${domain}; add the domain to Cloudflare first`);
  const steps = [`zone ${zone.name}`];
  const mx = await publicMx(domain);
  if (ROUTING_HOSTS.every((host) => mx.includes(host))) {
    steps.push("mail routing already on (MX present)");
  } else {
    if (mx.length > 0) throw new Error(`${domain} already receives mail elsewhere (MX ${mx.join(", ")}); move it to Cloudflare Email Routing first`);
    try {
      // The zone's own name takes no "name"; a subdomain is named explicitly.
      await cloudflare(env, `/zones/${zone.id}/email/routing/dns`, "POST", domain === zone.name ? {} : { name: domain });
      steps.push("mail routing turned on (MX and SPF records published)");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already|exist|enabled/i.test(message)) throw new Error(`could not turn on mail routing for ${domain}: ${message}`, { cause: error });
      steps.push("mail routing already on");
    }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO managed_domains (domain, zone_id) VALUES (?, ?)").bind(domain, zone.id).run();
  return { zoneId: zone.id, newlyManaged: true, steps };
}
