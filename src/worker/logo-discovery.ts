const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_CANDIDATES = 16;

export interface LogoAsset {
  data: Uint8Array;
  contentType: string;
  pixels: number;
  vector: boolean;
  sourceType: string;
}

interface LogoCandidate {
  url: URL;
  priority: number;
  hintedPixels: number;
  sourceType: string;
}

interface SiteDiscovery {
  icons: LogoCandidate[];
  manifests: URL[];
}

export async function discoverPersonalLogo(address: string): Promise<{ asset: LogoAsset; source: URL } | null> {
  const digest = await sha256Hex(address.trim().toLowerCase());
  const candidates = [
    `https://gravatar.com/avatar/${digest}?s=512&d=404&r=g`,
    `https://seccdn.libravatar.org/avatar/${digest}?s=512&d=404`,
  ];
  const results = await Promise.all(candidates.map(async (value) => {
    const url = safeHttpsURL(value);
    if (!url) return null;
    const asset = await fetchLogo(url, "personal-avatar").catch(() => null);
    return asset ? { asset, source: url } : null;
  }));
  return results.find((result) => result !== null) ?? null;
}

export async function discoverDomainLogo(domain: string, bimiLogo?: URL): Promise<{ asset: LogoAsset; source: URL } | null> {
  if (bimiLogo) {
    const asset = await fetchLogo(bimiLogo, "bimi", true).catch(() => null);
    if (asset) return { asset: { ...asset, sourceType: "bimi" }, source: bimiLogo };
  }

  const roots = [`https://${domain}/`, `https://www.${domain}/`]
    .flatMap((value) => { const url = safeHttpsURL(value); return url ? [url] : []; });
  const discoveries = await Promise.all(roots.map((root) => discoverSite(root).catch(() => null)));
  const candidates = curatedCandidates(domain);
  for (const discovery of discoveries) {
    if (!discovery) continue;
    candidates.push(...discovery.icons);
    const manifests = await Promise.all(discovery.manifests.slice(0, 2).map((url) => discoverManifest(url).catch(() => [])));
    candidates.push(...manifests.flat());
  }
  candidates.push(...conventionalCandidates(domain));

  const unique = new Map<string, LogoCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.url.toString());
    if (!existing || candidate.priority + candidate.hintedPixels > existing.priority + existing.hintedPixels) {
      unique.set(candidate.url.toString(), candidate);
    }
  }
  const ranked = [...unique.values()]
    .sort((left, right) => candidateHintScore(right) - candidateHintScore(left))
    .slice(0, MAX_CANDIDATES);
  const results = await Promise.all(ranked.map(async (candidate) => {
    const asset = await fetchLogo(candidate.url, candidate.sourceType).catch(() => null);
    return asset ? { asset, candidate, score: assetScore(asset, candidate) } : null;
  }));
  const best = results.filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((left, right) => right.score - left.score)[0];
  return best ? { asset: best.asset, source: best.candidate.url } : null;
}

export function safeLogoSVG(data: Uint8Array, requireTinyPS = false): Uint8Array | null {
  const text = new TextDecoder().decode(data);
  const normalized = text.toLowerCase();
  if (!/<svg\b/.test(normalized) || (requireTinyPS && !/baseprofile\s*=\s*["']tiny-ps["']/.test(normalized))) return null;
  if (/<(?:script|foreignobject|iframe|object|embed|image)\b/.test(normalized)) return null;
  if (/\bon[a-z]+\s*=|<!doctype|<!entity|javascript\s*:|data\s*:|@import|expression\s*\(/.test(normalized)) return null;
  const references = normalized.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/g);
  if ([...references].some((match) => !match[1].startsWith("#"))) return null;
  const cssURLs = normalized.matchAll(/url\s*\(\s*["']?([^)'"\s]+)["']?\s*\)/g);
  if ([...cssURLs].some((match) => !match[1].startsWith("#"))) return null;
  return data;
}

export function extractHomepageIconURLs(html: string, pageURL: URL): string[] {
  return extractSiteDiscovery(html, pageURL).icons.map((candidate) => candidate.url.toString());
}

function curatedCandidates(domain: string): LogoCandidate[] {
  const candidates: LogoCandidate[] = [];
  const awsDomain = domain === "signin.aws" || domain.endsWith(".signin.aws") || domain === "amazonaws.com"
    || domain.endsWith(".amazonaws.com") || domain === "awsapps.com" || domain.endsWith(".awsapps.com");
  if (awsDomain) {
    addCandidate(candidates, "https://d1.awsstatic.com/onedam/marketing-channels/website/public/order_1457899342_logo.fc226207ed4e236d249fb57f627e23c04bd62edf.svg", 9_000, 2048, "official-brand");
  }
  if (domain === "gmail.com") addCandidate(candidates, "https://mail.google.com/favicon.ico", 7_500, 256, "official-brand");
  return candidates;
}

function conventionalCandidates(domain: string): LogoCandidate[] {
  const candidates: LogoCandidate[] = [];
  const hosts = [domain, `www.${domain}`];
  const paths: Array<[string, number, number, string]> = [
    ["/favicon.svg", 7_200, 2048, "conventional-svg"],
    ["/android-chrome-512x512.png", 6_900, 512, "android-icon"],
    ["/icon-512.png", 6_800, 512, "conventional-icon"],
    ["/favicon-512x512.png", 6_700, 512, "conventional-icon"],
    ["/apple-touch-icon.png", 6_500, 180, "apple-touch-icon"],
    ["/favicon.png", 5_500, 128, "conventional-icon"],
    ["/favicon.ico", 2_000, 32, "legacy-favicon"],
  ];
  for (const host of hosts) for (const [path, priority, pixels, sourceType] of paths) {
    addCandidate(candidates, `https://${host}${path}`, priority, pixels, sourceType);
  }
  return candidates;
}

async function discoverSite(root: URL): Promise<SiteDiscovery | null> {
  const response = await fetch(root, { headers: { Accept: "text/html,application/xhtml+xml" }, redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok || !response.body || !safeHttpsURL(response.url)) return null;
  const data = await readLimited(response.body, MAX_PAGE_BYTES);
  if (!data) return null;
  return extractSiteDiscovery(new TextDecoder().decode(data), new URL(response.url));
}

function extractSiteDiscovery(html: string, pageURL: URL): SiteDiscovery {
  const icons: LogoCandidate[] = [];
  const manifests: URL[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attributes.get("href");
    if (!href) continue;
    const url = resolveSafeURL(href, pageURL);
    if (!url) continue;
    if (rel.includes("manifest")) { manifests.push(url); continue; }
    const pixels = sizeHint(attributes.get("sizes"));
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) {
      icons.push({ url, priority: 7_000, hintedPixels: pixels || 180, sourceType: "apple-touch-icon" });
    } else if (rel.includes("mask-icon")) {
      icons.push({ url, priority: 7_400, hintedPixels: pixels || 2048, sourceType: "mask-icon" });
    } else if (rel.includes("icon") || rel.includes("shortcut")) {
      icons.push({ url, priority: attributes.get("type")?.includes("svg") ? 8_200 : 6_600,
        hintedPixels: pixels, sourceType: "html-icon" });
    }
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    const key = (attributes.get("property") ?? attributes.get("name") ?? attributes.get("itemprop") ?? "").toLowerCase();
    if (key !== "og:logo" && key !== "logo") continue;
    const url = resolveSafeURL(attributes.get("content") ?? "", pageURL);
    if (url) icons.push({ url, priority: 7_600, hintedPixels: 512, sourceType: "page-logo" });
  }
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectJSONLogos(JSON.parse(script[1]) as unknown, pageURL, icons); } catch { /* malformed site metadata */ }
  }
  return { icons, manifests: [...new Map(manifests.map((url) => [url.toString(), url])).values()] };
}

async function discoverManifest(url: URL): Promise<LogoCandidate[]> {
  const response = await fetch(url, { headers: { Accept: "application/manifest+json,application/json" }, redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok || !response.body || !safeHttpsURL(response.url)) return [];
  const data = await readLimited(response.body, MAX_MANIFEST_BYTES);
  if (!data) return [];
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(data)); } catch { return []; }
  if (typeof value !== "object" || value === null || !("icons" in value) || !Array.isArray(value.icons)) return [];
  return value.icons.flatMap((icon) => {
    if (typeof icon !== "object" || icon === null || !("src" in icon) || typeof icon.src !== "string") return [];
    const iconURL = resolveSafeURL(icon.src, new URL(response.url));
    if (!iconURL) return [];
    const sizes = "sizes" in icon && typeof icon.sizes === "string" ? sizeHint(icon.sizes) : 0;
    const type = "type" in icon && typeof icon.type === "string" ? icon.type : "";
    return [{ url: iconURL, priority: type.includes("svg") ? 8_400 : 7_800, hintedPixels: sizes,
      sourceType: "web-manifest" }];
  });
}

async function fetchLogo(url: URL, sourceType: string, requireTinyPS = false): Promise<LogoAsset | null> {
  const response = await fetch(url, { headers: { Accept: "image/svg+xml,image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,image/vnd.microsoft.icon;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok || !response.body || !safeHttpsURL(response.url)) return null;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGO_BYTES) { await response.body.cancel(); return null; }
  const data = await readLimited(response.body, MAX_LOGO_BYTES);
  if (!data) return null;
  const metadata = imageMetadata(data);
  if (!metadata) return null;
  if (metadata.contentType === "image/svg+xml" && !safeLogoSVG(data, requireTinyPS)) return null;
  return { data, contentType: metadata.contentType === "image/svg+xml" ? "image/svg+xml; charset=utf-8" : metadata.contentType,
    pixels: metadata.pixels, vector: metadata.vector, sourceType };
}

function imageMetadata(data: Uint8Array): { contentType: string; pixels: number; vector: boolean } | null {
  if (data.length >= 24 && data[0] === 0x89 && ascii(data, 1, 4) === "PNG") {
    return { contentType: "image/png", pixels: Math.min(uint32(data, 16), uint32(data, 20)), vector: false };
  }
  if (data.length >= 10 && (ascii(data, 0, 6) === "GIF87a" || ascii(data, 0, 6) === "GIF89a")) {
    return { contentType: "image/gif", pixels: Math.min(uint16LE(data, 6), uint16LE(data, 8)), vector: false };
  }
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") {
    return { contentType: "image/webp", pixels: webpPixels(data), vector: false };
  }
  if (data.length >= 12 && ascii(data, 4, 12).includes("ftypavif")) {
    return { contentType: "image/avif", pixels: 512, vector: false };
  }
  if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
    let pixels = 0;
    const count = Math.min(uint16LE(data, 4), Math.floor((data.length - 6) / 16));
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      pixels = Math.max(pixels, data[offset] || 256, data[offset + 1] || 256);
    }
    return { contentType: "image/x-icon", pixels, vector: false };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { contentType: "image/jpeg", pixels: jpegPixels(data), vector: false };
  }
  const prefix = new TextDecoder().decode(data.slice(0, Math.min(data.length, 2048))).trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || prefix.startsWith("<?xml") && prefix.includes("<svg")) {
    return { contentType: "image/svg+xml", pixels: 4096, vector: true };
  }
  return null;
}

function jpegPixels(data: Uint8Array): number {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    const length = (data[offset + 2] << 8) | data[offset + 3];
    if (length < 2) break;
    if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker)) {
      return Math.min((data[offset + 5] << 8) | data[offset + 6], (data[offset + 7] << 8) | data[offset + 8]);
    }
    offset += 2 + length;
  }
  return 0;
}

function webpPixels(data: Uint8Array): number {
  const kind = ascii(data, 12, 16);
  if (kind === "VP8X" && data.length >= 30) {
    const width = 1 + data[24] + (data[25] << 8) + (data[26] << 16);
    const height = 1 + data[27] + (data[28] << 8) + (data[29] << 16);
    return Math.min(width, height);
  }
  return 0;
}

function collectJSONLogos(value: unknown, pageURL: URL, output: LogoCandidate[], depth = 0): void {
  if (depth > 5 || value === null) return;
  if (Array.isArray(value)) { for (const item of value) collectJSONLogos(item, pageURL, output, depth + 1); return; }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "logo") {
      const raw = typeof item === "string" ? item : typeof item === "object" && item !== null && "url" in item && typeof item.url === "string" ? item.url : null;
      const url = raw ? resolveSafeURL(raw, pageURL) : null;
      if (url) output.push({ url, priority: 7_700, hintedPixels: 512, sourceType: "structured-logo" });
    } else collectJSONLogos(item, pageURL, output, depth + 1);
  }
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value.replaceAll(/&amp;/gi, "&").replaceAll(/&quot;/gi, '"').replaceAll(/&#39;|&apos;/gi, "'")
    .replaceAll(/&lt;/gi, "<").replaceAll(/&gt;/gi, ">");
}

function sizeHint(value: string | undefined): number {
  if (!value) return 0;
  if (value.toLowerCase() === "any") return 2048;
  return Math.max(0, ...[...value.matchAll(/(\d+)x(\d+)/gi)].map((match) => Math.min(Number(match[1]), Number(match[2]))));
}

function addCandidate(output: LogoCandidate[], value: string, priority: number, hintedPixels: number, sourceType: string): void {
  const url = safeHttpsURL(value);
  if (url) output.push({ url, priority, hintedPixels, sourceType });
}

function candidateHintScore(candidate: LogoCandidate): number {
  return candidate.priority + Math.min(candidate.hintedPixels, 2048);
}

function assetScore(asset: LogoAsset, candidate: LogoCandidate): number {
  return candidate.priority + (asset.vector ? 4_000 : Math.min(asset.pixels, 2048));
}

function resolveSafeURL(value: string, base: URL): URL | null {
  try { return safeHttpsURL(new URL(value, base).toString()); } catch { return null; }
}

export function safeHttpsURL(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") || host === "localhost" || host.endsWith(".local")
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;
    return url;
  } catch { return null; }
}

async function readLimited(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) { await reader.cancel(); return null; }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ascii(data: Uint8Array, start: number, end: number): string { return new TextDecoder().decode(data.slice(start, end)); }
function uint16LE(data: Uint8Array, offset: number): number { return data[offset] | (data[offset + 1] << 8); }
function uint32(data: Uint8Array, offset: number): number {
  return (data[offset] * 0x1000000) + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3];
}
