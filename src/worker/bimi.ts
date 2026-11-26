import { stableId } from "./crypto";
import { discoverDomainLogo, discoverPersonalLogo, safeHttpsURL, safeLogoSVG, type LogoAsset } from "./logo-discovery";
import type { Env } from "./types";

const CACHE_SECONDS = 30 * 24 * 60 * 60;
const CACHE_GENERATION = "hq-v1";
const MISSING_MARKER = `${CACHE_GENERATION}:missing`;

interface DnsJsonResponse {
  Status: number;
  Answer?: Array<{ type: number; data: string }>;
}

interface SenderLogoRow {
  object_key: string | null;
  source_url: string | null;
  status: "found" | "missing";
  checked_at: string;
}

export interface SenderLogoAsset {
  data: Uint8Array;
  contentType: string;
  etag?: string;
}

export function senderPassedDmarc(authenticationResults: string[], domain: string): boolean {
  const normalizedDomain = domain.toLowerCase().replace(/^@/, "");
  return authenticationResults.some((value) => {
    const normalized = value.toLowerCase().replaceAll(/\s+/g, " ");
    const fromMatch = normalized.match(/(?:^|[;\s])header\.from\s*=\s*([^;\s]+)/);
    return /(?:^|[;\s])dmarc\s*=\s*pass(?:[;\s(]|$)/.test(normalized)
      && fromMatch?.[1]?.replace(/\.$/, "") === normalizedDomain;
  });
}

export function authenticationResultsFromRawHeaders(raw: string): string[] {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return [];
  const unfolded = raw.slice(0, headerEnd).replaceAll(/\r?\n[\t ]+/g, " ");
  return unfolded.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== "authentication-results") return [];
    return [line.slice(separator + 1).trim()];
  });
}

export function parseBimiRecord(records: string[]): { logo: URL; certificate: URL | null } | null {
  for (const record of records) {
    const tags = new Map(record.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? [part.toLowerCase(), ""] : [part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim()];
    }));
    if (tags.get("v")?.toUpperCase() !== "BIMI1") continue;
    const logo = safeHttpsURL(tags.get("l"));
    const certificate = safeHttpsURL(tags.get("a"));
    if (logo) return { logo, certificate };
  }
  return null;
}

export function safeBimiSVG(data: Uint8Array, requireTinyPS = true): Uint8Array | null {
  return safeLogoSVG(data, requireTinyPS);
}

export async function senderLogo(env: Env, requestedDomain: string, requestedAddress?: string): Promise<SenderLogoAsset | null> {
  const domain = requestedDomain.toLowerCase().replace(/\.$/, "");
  const address = requestedAddress?.trim().toLowerCase();
  if (address && isLikelyPersonalAddress(address)) {
    const personalKey = `email:${address}`;
    const personalCached = await cachedLogo(env, personalKey);
    if (personalCached.state === "found") return personalCached.asset;
    if (personalCached.state !== "missing") {
      const personal = await discoverPersonalLogo(address).catch(() => null);
      if (personal) return saveFound(env, personalKey, personal.source, personal.asset);
      await saveMissing(env, personalKey);
    }
  }

  const cached = await cachedLogo(env, domain);
  if (cached.state === "found") return cached.asset;
  if (cached.state === "missing") return null;

  const records = await txtRecords(`default._bimi.${domain}`);
  const record = parseBimiRecord(records);
  const discovered = await discoverDomainLogo(domain, record?.logo).catch(() => null);
  if (!discovered) { await saveMissing(env, domain); return null; }
  return saveFound(env, domain, discovered.source, discovered.asset);
}

function isLikelyPersonalAddress(address: string): boolean {
  const local = address.split("@")[0];
  return !/^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|alerts?|billing|security|support|info|admin|hello|news|updates?|receipts?|orders?)\b/i.test(local);
}

async function cachedLogo(env: Env, key: string): Promise<{ state: "found"; asset: SenderLogoAsset } | { state: "missing" | "stale" }> {
  const cached = await env.DB.prepare(`SELECT object_key, source_url, status, checked_at FROM sender_logos
    WHERE domain = ? AND checked_at >= datetime('now', '-30 days')`).bind(key).first<SenderLogoRow>();
  if (cached) {
    if (cached.status === "found" && cached.object_key) {
      const object = await env.MAIL.get(cached.object_key);
      if (object?.customMetadata?.generation === CACHE_GENERATION) {
        return { state: "found", asset: { data: new Uint8Array(await object.arrayBuffer()),
          contentType: object.httpMetadata?.contentType ?? "image/svg+xml; charset=utf-8", etag: object.httpEtag } };
      }
    }
    if (cached.status === "missing" && cached.source_url === MISSING_MARKER) return { state: "missing" };
  }
  return { state: "stale" };
}

async function saveFound(env: Env, key: string, source: URL, asset: LogoAsset): Promise<SenderLogoAsset> {
  const objectKey = `sender-logos/${await stableId(key)}.img`;
  const object = await env.MAIL.put(objectKey, asset.data, { httpMetadata: { contentType: asset.contentType }, customMetadata: {
    generation: CACHE_GENERATION, pixels: String(asset.pixels), vector: String(asset.vector), sourceType: asset.sourceType,
  } });
  await env.DB.prepare(`INSERT INTO sender_logos (domain, object_key, source_url, status, checked_at)
    VALUES (?, ?, ?, 'found', CURRENT_TIMESTAMP) ON CONFLICT(domain) DO UPDATE SET object_key = excluded.object_key,
    source_url = excluded.source_url, status = 'found', checked_at = CURRENT_TIMESTAMP`)
    .bind(key, objectKey, source.toString()).run();
  return { data: asset.data, contentType: asset.contentType, etag: object.httpEtag };
}

export const senderLogoCacheSeconds = CACHE_SECONDS;

async function txtRecords(name: string): Promise<string[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return [];
  const payload = await response.json<DnsJsonResponse>();
  if (payload.Status !== 0) return [];
  return (payload.Answer ?? []).filter((answer) => answer.type === 16).map((answer) => decodeTxt(answer.data));
}

function decodeTxt(value: string): string {
  return value.replaceAll(/^"|"$/g, "").replaceAll(/"\s*"/g, "").replaceAll("\\\"", "\"");
}

async function saveMissing(env: Env, key: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO sender_logos (domain, source_url, status, checked_at) VALUES (?, ?, 'missing', CURRENT_TIMESTAMP)
    ON CONFLICT(domain) DO UPDATE SET object_key = NULL, source_url = excluded.source_url, status = 'missing', checked_at = CURRENT_TIMESTAMP`)
    .bind(key, MISSING_MARKER).run();
}
