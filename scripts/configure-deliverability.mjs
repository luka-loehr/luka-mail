import process from "node:process";

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const email = process.env.CF_API_EMAIL?.trim();
const key = process.env.CF_API_KEY?.trim();
if (!apiToken && (!email || !key)) {
  throw new Error("CLOUDFLARE_API_TOKEN (recommended, scoped to DNS Write) or CF_API_EMAIL + CF_API_KEY is required");
}

const zonesRaw = process.env.CF_ZONES_JSON;
const dmarcAddress = process.env.DMARC_REPORT_ADDRESS?.trim().toLowerCase();
const tlsAddress = process.env.TLS_REPORT_ADDRESS?.trim().toLowerCase();
const rootDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();

if (!zonesRaw) throw new Error("CF_ZONES_JSON is required (e.g. '{\"example.com\":\"<zone-id>\"}')");
if (!dmarcAddress) throw new Error("DMARC_REPORT_ADDRESS is required (e.g. 'dmarc@example.com')");
if (!tlsAddress) throw new Error("TLS_REPORT_ADDRESS is required (e.g. 'tlsrpt@example.com')");
if (!rootDomain) throw new Error("ROOT_DOMAIN is required (e.g. 'example.com')");

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const ZONE_ID_PATTERN = /^[a-f0-9]{32}$/i;

if (!EMAIL_PATTERN.test(dmarcAddress)) throw new Error("DMARC_REPORT_ADDRESS must be a single valid email address");
if (!EMAIL_PATTERN.test(tlsAddress)) throw new Error("TLS_REPORT_ADDRESS must be a single valid email address");
if (!DOMAIN_PATTERN.test(rootDomain)) throw new Error("ROOT_DOMAIN must be a valid DNS domain");

const zones = JSON.parse(zonesRaw);
if (!zones || typeof zones !== "object" || Array.isArray(zones)) {
  throw new Error("CF_ZONES_JSON must be a JSON object mapping domains to Cloudflare zone IDs");
}
for (const [domain, zoneId] of Object.entries(zones)) {
  if (!DOMAIN_PATTERN.test(domain) || typeof zoneId !== "string" || !ZONE_ID_PATTERN.test(zoneId)) {
    throw new Error(`Invalid domain or 32-hex Cloudflare zone ID in CF_ZONES_JSON for ${domain}`);
  }
}

const dmarc = `v=DMARC1; p=reject; pct=100; rua=mailto:${dmarcAddress}`;
const tlsRpt = `v=TLSRPTv1; rua=mailto:${tlsAddress}`;
const mtaSts = "v=STSv1; id=20260808-1;";

const authHeaders = apiToken
  ? { Authorization: `Bearer ${apiToken}` }
  : { "X-Auth-Email": email, "X-Auth-Key": key };

async function cf(path, init = {}) {
  const response = await globalThis.fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { ...authHeaders, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare ${path} failed: ${JSON.stringify(body.errors ?? response.status)}`);
  }
  return body.result;
}

async function upsertTxt(zoneId, name, content) {
  const records = await cf(`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=100`);
  if (records.length > 1) throw new Error(`Refusing to modify duplicate TXT records for ${name}`);
  const body = JSON.stringify({ type: "TXT", name, content, ttl: 1 });
  if (records.length === 0) {
    await cf(`/zones/${zoneId}/dns_records`, { method: "POST", body });
    globalThis.console.log(`created ${name}`);
  } else if (records[0].content !== content || records[0].ttl !== 1) {
    await cf(`/zones/${zoneId}/dns_records/${records[0].id}`, { method: "PATCH", body });
    globalThis.console.log(`updated ${name}`);
  } else {
    globalThis.console.log(`unchanged ${name}`);
  }
}

for (const [domain, zoneId] of Object.entries(zones)) {
  await upsertTxt(zoneId, `_dmarc.${domain}`, dmarc);
  await upsertTxt(zoneId, `_mta-sts.${domain}`, mtaSts);
  await upsertTxt(zoneId, `_smtp._tls.${domain}`, tlsRpt);
}

const rootZone = zones[rootDomain];
if (rootZone) {
  for (const source of Object.keys(zones)) {
    if (source === rootDomain) continue;
    await upsertTxt(rootZone, `${source}._report._dmarc.${rootDomain}`, "v=DMARC1");
  }
}
