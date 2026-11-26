import { accountId, dmarcReportAddress, managedDomains, MTA_STS_POLICY, ROUTING_HOSTS, tlsReportAddress } from "./config";
import type { Env } from "./types";

interface DnsAnswer { data: string }
interface DeliveryEvent {
  datetime: string;
  from: string;
  to: string;
  status: string;
  eventType: string;
  sendingDomain: string;
  messageId: string;
  errorCause: string | null;
  errorDetail: string | null;
  dkim: string | null;
  dmarc: string | null;
  spf: string | null;
  isSpam: number | null;
  spamScore: number | null;
  spamThreshold: number | null;
}

const GRAPHQL_QUERY = `query($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    emailSendingAdaptive(filter: { datetime_geq: $start, datetime_leq: $end }, limit: 5000, orderBy: [datetime_DESC]) {
      datetime from to status eventType sendingDomain messageId errorCause errorDetail dkim dmarc spf isSpam spamScore spamThreshold
    }
  } }
}`;

function cleanTxt(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/"\s+"/g, "");
}

async function resolveDns(name: string, type: "MX" | "TXT"): Promise<DnsAnswer[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`DNS lookup failed for ${name}: HTTP ${response.status}`);
  const body = await response.json<{ Answer?: DnsAnswer[] }>();
  return (body.Answer ?? []).map((answer) => ({ data: type === "TXT" ? cleanTxt(answer.data) : answer.data }));
}

function tag(record: string | undefined, name: string): string | null {
  return record?.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`, "i"))?.[1]?.trim() ?? null;
}

function authFailure(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && !["none", "pass", "neutral"].includes(normalized));
}

export function aggregateEvents(events: DeliveryEvent[]) {
  const statuses: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let delivered = 0;
  let rejected = 0;
  let spamSignals = 0;
  let complaints = 0;
  let spamScoreTotal = 0;
  let spamScoreSamples = 0;
  let maxSpamScore: number | null = null;
  const authenticationFailures: Array<Record<string, unknown>> = [];

  for (const event of events) {
    const status = event.status || event.eventType || "unknown";
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (status.toLowerCase() === "delivered") delivered += 1;
    if (["rejected", "bounced", "failed"].includes(status.toLowerCase())) rejected += 1;
    if (event.errorCause) errors[event.errorCause] = (errors[event.errorCause] ?? 0) + 1;
    const complaintText = `${event.status} ${event.eventType} ${event.errorCause ?? ""} ${event.errorDetail ?? ""}`.toLowerCase();
    if (complaintText.includes("complaint") || complaintText.includes("feedback loop")) complaints += 1;
    if (event.isSpam === 1) spamSignals += 1;
    if (typeof event.spamScore === "number") {
      spamScoreTotal += event.spamScore;
      spamScoreSamples += 1;
      maxSpamScore = Math.max(maxSpamScore ?? event.spamScore, event.spamScore);
    }
    if (authFailure(event.spf) || authFailure(event.dkim) || authFailure(event.dmarc)) {
      authenticationFailures.push({
        datetime: event.datetime, sendingDomain: event.sendingDomain, messageId: event.messageId,
        spf: event.spf, dkim: event.dkim, dmarc: event.dmarc,
      });
    }
  }
  return {
    total: events.length,
    delivered,
    rejected,
    deliveryRate: events.length ? delivered / events.length : null,
    statuses,
    errors,
    bounces: Object.entries(errors).filter(([key]) => /bounce/i.test(key)).reduce((sum, [, value]) => sum + value, 0),
    complaints,
    observedComplaintRate: events.length ? complaints / events.length : 0,
    reputationSignals: {
      spamSignals,
      spamSignalRate: events.length ? spamSignals / events.length : 0,
      averageSpamScore: spamScoreSamples ? spamScoreTotal / spamScoreSamples : null,
      maxSpamScore,
    },
    authenticationFailures: authenticationFailures.slice(0, 100),
  };
}

async function cloudflareJson<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.DELIVERABILITY_API_TOKEN}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cloudflare API ${path} failed: HTTP ${response.status}`);
  return await response.json<T>();
}

async function deliveryEvents(env: Env, start: string, end: string): Promise<DeliveryEvent[]> {
  const zoneIds = [...new Set(Object.values(managedDomains(env)))];
  const results = await Promise.all(zoneIds.map(async (zoneTag) => {
    const result = await cloudflareJson<{ data?: { viewer?: { zones?: Array<{ emailSendingAdaptive?: DeliveryEvent[] }> } }; errors?: unknown[] }>(
      env, "/graphql", { method: "POST", body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { zoneTag, start, end } }) },
    );
    if (result.errors?.length) throw new Error("Cloudflare analytics query returned errors");
    return result.data?.viewer?.zones?.[0]?.emailSendingAdaptive ?? [];
  }));
  return results.flat().sort((a, b) => b.datetime.localeCompare(a.datetime));
}

function resultValue<T>(body: { result?: T } | T): T {
  return typeof body === "object" && body !== null && "result" in body ? (body as { result: T }).result : body as T;
}

async function checkDomain(domain: string, reportAddress: string, tlsReportAddr: string) {
  const [mx, rootTxt, dkimTxt, dmarcTxt, mtaTxt, tlsTxt] = await Promise.all([
    resolveDns(domain, "MX"), resolveDns(domain, "TXT"), resolveDns(`cf-bounce._domainkey.${domain}`, "TXT"),
    resolveDns(`_dmarc.${domain}`, "TXT"), resolveDns(`_mta-sts.${domain}`, "TXT"), resolveDns(`_smtp._tls.${domain}`, "TXT"),
  ]);
  const mxHosts = new Set(mx.map((answer) => answer.data.split(/\s+/).at(-1)?.replace(/\.$/, "")));
  const mxOk = ROUTING_HOSTS.length === mxHosts.size && ROUTING_HOSTS.every((host) => mxHosts.has(host));
  const spfRecord = rootTxt.map((answer) => answer.data).find((record) => /^v=spf1\b/i.test(record));
  const dkimRecord = dkimTxt.map((answer) => answer.data).find((record) => /^v=DKIM1\b/i.test(record));
  const dmarcRecord = dmarcTxt.map((answer) => answer.data).find((record) => /^v=DMARC1\b/i.test(record));
  const mtaRecord = mtaTxt.map((answer) => answer.data).find((record) => /^v=STSv1\b/i.test(record));
  const tlsRecord = tlsTxt.map((answer) => answer.data).find((record) => /^v=TLSRPTv1\b/i.test(record));
  // Fetching the Worker's own custom domain from inside the same Worker can loop at
  // Cloudflare's edge. The API validates the exact served source; the CLI separately
  // performs the public HTTPS/TLS request and folds that result into domain health.
  const policy = MTA_STS_POLICY;
  const policyMx = new Set([...policy.matchAll(/^mx:\s*(\S+)\s*$/gim)].map((match) => match[1].toLowerCase()));
  const mtaPolicyOk = /^version:\s*STSv1\s*$/im.test(policy) && /^mode:\s*enforce\s*$/im.test(policy)
    && ROUTING_HOSTS.every((host) => policyMx.has(host)) && /^max_age:\s*\d+\s*$/im.test(policy);
  const dmarcPolicy = tag(dmarcRecord, "p")?.toLowerCase() ?? null;
  const dmarcRua = tag(dmarcRecord, "rua") ?? null;
  const checks = {
    mx: mxOk,
    spf: Boolean(spfRecord?.includes("include:_spf.mx.cloudflare.net")),
    dkim: Boolean(dkimRecord),
    dmarc: Boolean(dmarcRecord && dmarcPolicy === "reject" && tag(dmarcRecord, "pct") === "100" && (!reportAddress || dmarcRua === `mailto:${reportAddress}`)),
    mtaSts: Boolean(mtaRecord && tag(mtaRecord, "id") && mtaPolicyOk),
    tlsRpt: Boolean(tlsRecord && (!tlsReportAddr || tag(tlsRecord, "rua") === `mailto:${tlsReportAddr}`)),
  };
  return {
    domain, ok: Object.values(checks).every(Boolean), checks,
    alignmentPolicy: { spfDomain: domain, dkimDomain: domain, dmarcPolicy, dmarcRua },
    mtaSts: { policyUrl: `https://mta-sts.${domain}/.well-known/mta-sts.txt`, mode: mtaPolicyOk ? "enforce" : null },
    tlsRpt: { rua: tag(tlsRecord, "rua") },
  };
}

export async function buildDeliverabilityReport(env: Env, hours: number) {
  const startedAt = Date.now();
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const domainsMap = managedDomains(env);
  const acctId = accountId(env);
  const reportAddress = dmarcReportAddress(env);
  const tlsReportAddr = tlsReportAddress(env);
  const reportAddresses = [reportAddress, tlsReportAddr].filter(Boolean);
  const [domains, events, limitsBody, suppressionsBody, reportMail] = await Promise.all([
    Promise.all(Object.keys(domainsMap).map((domain) => checkDomain(domain, reportAddress, tlsReportAddr))),
    deliveryEvents(env, start.toISOString(), end.toISOString()),
    acctId ? cloudflareJson<{ result?: unknown } | unknown>(env, `/accounts/${acctId}/email/sending/limits`) : Promise.resolve(null),
    acctId ? cloudflareJson<{ result?: unknown[] } | unknown[]>(env, `/accounts/${acctId}/email/sending/suppressions?page=1&per_page=100`) : Promise.resolve([]),
    reportAddresses.length > 0
      ? env.DB.prepare(`SELECT identity_address AS address, COUNT(*) AS messages, MAX(received_at) AS latest
          FROM messages WHERE direction = 'inbound' AND identity_address IN (${reportAddresses.map(() => "?").join(", ")}) GROUP BY identity_address`)
        .bind(...reportAddresses).all<{ address: string; messages: number; latest: string | null }>()
      : Promise.resolve({ results: [] as Array<{ address: string; messages: number; latest: string | null }> }),
  ]);
  const suppressions = resultValue<unknown[]>(suppressionsBody);
  const delivery = aggregateEvents(events);
  const healthy = domains.every((domain) => domain.ok) && delivery.authenticationFailures.length === 0;
  return {
    healthy,
    status: healthy && delivery.rejected === 0 && suppressions.length === 0 ? "healthy" : healthy ? "degraded" : "unhealthy",
    checkedAt: end.toISOString(),
    window: { hours, start: start.toISOString(), end: end.toISOString() },
    durationMs: Date.now() - startedAt,
    checks: {
      domains,
      cloudflare: { limits: resultValue(limitsBody), suppressions: { count: suppressions.length, entries: suppressions.slice(0, 100) }, delivery },
      reports: { addresses: reportAddresses, inbox: reportMail.results },
    },
    notes: [
      "Complaint rate and reputation are observed Cloudflare event signals, not guarantees of recipient inbox placement.",
      "Authentication values reported as 'none' by Cloudflare are informational and are not counted as failures.",
    ],
  };
}
