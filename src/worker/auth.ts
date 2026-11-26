import type { Context, MiddlewareHandler } from "hono";
import { randomToken, sha256 } from "./crypto";
import type { ApiKeyRow, Env } from "./types";

export interface AuthPrincipal {
  keyId: string;
  name: string;
  scopes: string[];
  allowedIdentities: string[] | null;
}

export type ApiVariables = {
  principal: AuthPrincipal;
  requestId: string;
  authMethod: "api-key" | "passkey-session";
};

type ApiContext = { Bindings: Env; Variables: ApiVariables };
const TOKEN_PATTERN = /^lm_(live|device)_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{80,100})$/;
const NATIVE_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const NATIVE_SESSION_SCOPES = ["account:read", "mail:read", "mail:write", "mail:send", "addresses:read"] as const;

type AuthenticatedPrincipal = {
  row: ApiKeyRow;
  authMethod: "api-key" | "passkey-session";
  nativeSessionHash?: string;
  nativeSessionLastSeenAt?: string;
};

type NativeSessionAuthRow = ApiKeyRow & {
  session_scopes_json: string;
  session_allowed_identities_json: string;
  session_last_seen_at: string;
  enabled_identities_json: string;
};

export type NativeSessionPolicy = {
  scopes: string[];
  allowedIdentities: string[];
};

const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1_000;

export const securityHeaders: MiddlewareHandler<ApiContext> = async (c, next) => {
  await next();
  const isHtml = c.res.headers.get("Content-Type")?.startsWith("text/html") ?? false;
  if (isHtml) {
    const scriptHashes = await inlineScriptHashes(c.res);
    c.header("Content-Security-Policy", `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'self' blob:; img-src 'self' data: blob:; object-src 'none'; script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(" ")}` : ""}; style-src 'self' 'unsafe-inline'`);
  } else {
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
  const isDynamic = c.req.path === "/health" || c.req.path.startsWith("/auth/") || c.req.path.startsWith("/v1/");
  if ((isHtml || isDynamic) && !c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  else if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "public, max-age=31536000, immutable");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
};

async function inlineScriptHashes(response: Response): Promise<string[]> {
  const html = await response.clone().text();
  const hashes = new Set<string>();
  const encoder = new TextEncoder();
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const source = match[1];
    if (!source) continue;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(source)));
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    hashes.add(`'sha256-${btoa(binary)}'`);
  }
  return [...hashes];
}

export const requireApiKey: MiddlewareHandler<ApiContext> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const edgeLimit = await c.env.AUTH_RATE_LIMITER.limit({ key: ip });
  if (!edgeLimit.success) {
    c.header("Retry-After", "60");
    return c.json({ error: "Rate limit exceeded", requestId }, 429);
  }
  const authorization = c.req.header("Authorization") ?? "";
  const bearer = /^Bearer (.+)$/.exec(authorization)?.[1];
  const authenticated = bearer
    ? await authenticateBearer(c.env, bearer)
    : await authenticateWebSession(c.env, cookieValue(c.req.header("Cookie"), "__Host-lmail-session"));
  if (!authenticated) return authFailure(c, requestId, null, "Authentication required", 401);
  const { row, authMethod } = authenticated;
  const keyId = row.id;
  if (authMethod === "passkey-session" && !bearer && !isSafeMethod(c.req.method) && !isSameOrigin(c.req.raw)) {
    return c.json({ error: "Cross-origin mutation rejected", requestId }, 403);
  }

  const apiLimit = await c.env.API_RATE_LIMITER.limit({ key: keyId });
  if (!apiLimit.success) {
    c.header("Retry-After", "60");
    return authFailure(c, requestId, keyId, "Rate limit exceeded", 429);
  }

  const scopes = safeScopes(row.scopes_json);
  c.set("principal", { keyId, name: row.name, scopes, allowedIdentities: safeIdentities(row.allowed_identities_json) });
  c.set("authMethod", authMethod);
  const activityUpdates: D1PreparedStatement[] = [];
  if (activityTimestampIsStale(row.last_used_at)) {
    activityUpdates.push(c.env.DB.prepare("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(keyId));
  }
  if (authenticated.nativeSessionHash && activityTimestampIsStale(authenticated.nativeSessionLastSeenAt)) {
    activityUpdates.push(c.env.DB.prepare("UPDATE native_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
      .bind(authenticated.nativeSessionHash));
  }
  if (activityUpdates.length > 0) {
    c.executionCtx.waitUntil(c.env.DB.batch(activityUpdates).then(() => undefined));
  }
  await next();
};

export async function authenticateBearer(env: Env, token: string): Promise<AuthenticatedPrincipal | null> {
  const tokenMatch = token.match(TOKEN_PATTERN);
  if (tokenMatch) {
    const [, tokenKind, keyId, secret] = tokenMatch;
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(keyId).first<ApiKeyRow>();
    const actualHash = tokenKind === "device"
      ? row?.secret_hash.startsWith("device-v2:")
        ? `device-v2:${await sha256(`${env.API_KEY_PEPPER}:device:${secret}`)}`
        : `device:${await sha256(secret)}`
      : await sha256(`${env.API_KEY_PEPPER}:${secret}`);
    if (!row || !await constantTimeEqual(actualHash, row.secret_hash) || !isActiveKey(row)) return null;
    return { row, authMethod: "api-key" };
  }
  return authenticateNativeSession(env, token);
}

export async function authenticateNativeSession(env: Env, token: string): Promise<AuthenticatedPrincipal | null> {
  if (!NATIVE_SESSION_PATTERN.test(token)) return null;
  const tokenHash = await sha256(token);
  const stored = await env.DB.prepare(`SELECT k.*, s.scopes_json AS session_scopes_json,
      s.allowed_identities_json AS session_allowed_identities_json,
      s.last_seen_at AS session_last_seen_at,
      (SELECT COALESCE(json_group_array(address), '[]') FROM
        (SELECT address FROM identities WHERE enabled = 1 ORDER BY address)) AS enabled_identities_json
    FROM native_sessions s JOIN api_keys k ON k.id = s.key_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`).bind(tokenHash).first<NativeSessionAuthRow>();
  if (!stored || !isActiveKey(stored)) return null;
  const policy = await constrainedNativeSessionPolicy(env, stored, {
    scopes: safeScopes(stored.session_scopes_json),
    allowedIdentities: safeIdentities(stored.session_allowed_identities_json) ?? [],
  }, safeIdentities(stored.enabled_identities_json) ?? []);
  const row: ApiKeyRow = {
    id: stored.id,
    name: stored.name,
    secret_hash: stored.secret_hash,
    scopes_json: JSON.stringify(policy.scopes),
    expires_at: stored.expires_at,
    revoked_at: stored.revoked_at,
    created_by: stored.created_by,
    created_at: stored.created_at,
    last_used_at: stored.last_used_at,
    allowed_identities_json: JSON.stringify(policy.allowedIdentities),
  };
  return { row, authMethod: "passkey-session", nativeSessionHash: tokenHash,
    nativeSessionLastSeenAt: stored.session_last_seen_at };
}

export async function constrainedNativeSessionPolicy(
  env: Env,
  parent: ApiKeyRow,
  snapshot?: NativeSessionPolicy,
  knownEnabledIdentities?: string[],
): Promise<NativeSessionPolicy> {
  const parentScopes = safeScopes(parent.scopes_json);
  const snapshotScopes = new Set(snapshot?.scopes ?? NATIVE_SESSION_SCOPES);
  const scopes = NATIVE_SESSION_SCOPES.filter((scope) => snapshotScopes.has(scope) && hasScope(parentScopes, scope));

  const parentIdentities = safeIdentities(parent.allowed_identities_json);
  const parentIdentitySet = parentIdentities === null ? null : new Set(parentIdentities.map(normalizeIdentity));
  // An unrestricted parent key intentionally follows the live enabled identity
  // set. Restricted parents retain the session-time snapshot so a later parent
  // expansion cannot silently broaden an already-issued native session.
  const snapshotIdentitySet = snapshot && parentIdentitySet !== null
    ? new Set(snapshot.allowedIdentities.map(normalizeIdentity)) : null;
  const enabledIdentities = knownEnabledIdentities ?? (await env.DB.prepare("SELECT address FROM identities WHERE enabled = 1 ORDER BY address")
    .all<{ address: string }>()).results.map((row) => row.address);
  const allowedIdentities = enabledIdentities.map(normalizeIdentity).filter((address) =>
    (parentIdentitySet === null || parentIdentitySet.has(address))
      && (snapshotIdentitySet === null || snapshotIdentitySet.has(address)));
  return { scopes: [...scopes], allowedIdentities };
}

export async function authenticateWebSession(env: Env, token: string | null): Promise<AuthenticatedPrincipal | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`SELECT k.* FROM web_sessions s JOIN api_keys k ON k.id = s.key_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`).bind(tokenHash).first<ApiKeyRow>();
  if (!row || !isActiveKey(row)) return null;
  return { row, authMethod: "passkey-session" };
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const item of (header ?? "").split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key !== name) continue;
    // A malformed percent-escape is an invalid session, not a server error.
    try { return decodeURIComponent(rest.join("=")); } catch { return null; }
  }
  return null;
}

export function requireScope(required: string): MiddlewareHandler<ApiContext> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!hasScope(principal.scopes, required)) return c.json({ error: "Insufficient scope", required, requestId: c.get("requestId") }, 403);
    await next();
  };
}

export const auditRequest: MiddlewareHandler<ApiContext> = async (c, next) => {
  await next();
  if (!shouldPersistAudit(c.req.method, new URL(c.req.url).pathname)) return;
  const principal = c.get("principal");
  const action = `${c.req.method} ${new URL(c.req.url).pathname}`;
  c.executionCtx.waitUntil(writeAudit(c, {
    requestId: c.get("requestId"),
    keyId: principal.keyId,
    actor: principal.name,
    action,
    resource: c.req.param("id") ?? c.req.param("address") ?? "-",
    status: c.res.status,
  }));
};

export async function issueApiKey(env: Env, name: string, scopes: string[], allowedIdentities: string[] | null,
  expiresAt: string | null, createdBy: string): Promise<{ id: string; token: string }> {
  const id = randomToken(12).slice(0, 16);
  const secret = randomToken(64);
  const token = `lm_live_${id}_${secret}`;
  const secretHash = await sha256(`${env.API_KEY_PEPPER}:${secret}`);
  await env.DB.prepare(`INSERT INTO api_keys (id, name, secret_hash, scopes_json, allowed_identities_json, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, name, secretHash, JSON.stringify(scopes),
      allowedIdentities === null ? null : JSON.stringify(allowedIdentities), expiresAt, createdBy).run();
  return { id, token };
}

export async function issueDeviceApiKey(env: Env, name: string, scopes: string[], allowedIdentities: string[],
  expiresAt: string, createdBy: string): Promise<{ id: string; token: string }> {
  const id = randomToken(12).slice(0, 16);
  const secret = randomToken(64);
  const token = `lm_device_${id}_${secret}`;
  const secretHash = `device-v2:${await sha256(`${env.API_KEY_PEPPER}:device:${secret}`)}`;
  await env.DB.prepare(`INSERT INTO api_keys (id, name, secret_hash, scopes_json, allowed_identities_json, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, name, secretHash, JSON.stringify(scopes),
      JSON.stringify(allowedIdentities), expiresAt, createdBy).run();
  return { id, token };
}

export function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("*")) return true;
  if (scopes.includes(required)) return true;
  const namespace = required.split(":")[0];
  return scopes.includes(`${namespace}:*`);
}

async function authFailure(c: Context<ApiContext>, requestId: string, keyId: string | null, message: string, status: 401 | 429): Promise<Response> {
  // Invalid credentials are intentionally not persisted to D1: an anonymous attacker
  // must not be able to turn authentication failures into unbounded database writes.
  console.warn("Authentication rejected", { requestId, keyId, status, path: new URL(c.req.url).pathname });
  return c.json({ error: message, code: status === 429 ? "rate_limited" : "unauthorized",
    retryable: status === 429, requestId }, status, { "WWW-Authenticate": "Bearer" });
}

function activityTimestampIsStale(value: string | null | undefined): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= ACTIVITY_WRITE_INTERVAL_MS;
}

function shouldPersistAudit(method: string, path: string): boolean {
  if (!isSafeMethod(method)) return true;
  return path === "/v1/doctor" || path === "/v1/deliverability" || path === "/v1/keys" || path === "/v1/audit"
    || path.startsWith("/v1/send-requests/") || path.startsWith("/v1/attachments/")
    || /^\/v1\/messages\/[^/]+(?:\/raw)?$/.test(path);
}

async function writeAudit(c: Context<ApiContext>, event: { requestId: string; keyId: string | null; actor: string; action: string; resource: string; status: number }): Promise<void> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const ipHash = await sha256(`${c.env.AUDIT_IP_PEPPER}:${ip}`);
  await c.env.DB.prepare(`INSERT INTO audit_logs
    (id, request_id, key_id, actor, action, resource, status, ip_hash, user_agent, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), event.requestId, event.keyId, event.actor, event.action, event.resource, event.status,
      ipHash, c.req.header("User-Agent")?.slice(0, 512) ?? null,
      JSON.stringify({ colo: c.req.raw.cf?.colo ?? null, country: c.req.raw.cf?.country ?? null })).run();
}

function safeScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function isActiveKey(row: ApiKeyRow): boolean {
  return !row.revoked_at && (!row.expires_at || new Date(row.expires_at) > new Date());
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function safeIdentities(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean };
  return subtle.timingSafeEqual(leftHash, rightHash);
}
