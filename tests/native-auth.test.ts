import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateNativeSession } from "../src/worker/auth";
import { sha256 } from "../src/worker/crypto";
import { claimWebAuthnAssertion } from "../src/worker/webauthn-assertion";
import type { Env } from "../src/worker/types";

const KEY_ID = "nativeauthkey001";
const CREDENTIAL_ID = "native-credential";
const CALLBACK_URI = "lmail://auth/callback";
const LEGACY_CALLBACK_URI = "lukamail://auth/callback";
const OWNER = "owner@example.com";
const VERIFIER = "v".repeat(43);
const CODE = "c".repeat(43);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM native_sessions"),
    env.DB.prepare("DELETE FROM native_authorization_codes"),
    env.DB.prepare("DELETE FROM native_authorization_requests"),
    env.DB.prepare("DELETE FROM web_sessions"),
    env.DB.prepare("DELETE FROM webauthn_challenges"),
    env.DB.prepare("DELETE FROM webauthn_credentials"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(`INSERT INTO api_keys
    (id, name, secret_hash, scopes_json, allowed_identities_json)
    VALUES (?, 'Native passkey', 'unused-native-secret',
      '["account:read","mail:read","mail:write","mail:send","addresses:read"]',
      '["owner@example.com"]')`).bind(KEY_ID).run();
  await env.DB.prepare(`INSERT INTO webauthn_credentials
    (id, key_id, webauthn_user_id, public_key, counter, device_type, backed_up, transports_json, name)
    VALUES (?, ?, 'native-user', 'unused-public-key', 0, 'multiDevice', 1, '["internal"]', 'Native test passkey')`)
    .bind(CREDENTIAL_ID, KEY_ID).run();
});

describe("native passkey authorization contract", () => {
  it("serves a standalone, CSP-protected authorization page for the exact callback", async () => {
    const state = "s".repeat(43);
    const challenge = await sha256(VERIFIER);
    const url = new URL("https://mail.example.com/auth/native/authorize");
    url.searchParams.set("redirect_uri", CALLBACK_URI);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("platform", "macos");

    const response = await workerExports.default.fetch(new Request(url));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const nonceMatch = csp.match(/script-src 'self' 'nonce-([A-Za-z0-9_-]+)'/);
    expect(nonceMatch).not.toBeNull();
    expect(html).toContain(`<script nonce="${nonceMatch![1]}">`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(html).toContain("Authorize lmail Test");
    expect(html).toContain("navigator.credentials.get");
    expect(html).not.toContain("unused-native-secret");
    const stored = await env.DB.prepare(`SELECT redirect_uri, state, code_challenge, platform
      FROM native_authorization_requests`).first<{
        redirect_uri: string; state: string; code_challenge: string; platform: string;
      }>();
    expect(stored).toEqual({ redirect_uri: CALLBACK_URI, state, code_challenge: challenge, platform: "macos" });

    // Legacy Apple client callback URI remains accepted for backward compatibility.
    const legacy = await workerExports.default.fetch(new Request(authorizationUrl({ redirectUri: LEGACY_CALLBACK_URI })));
    expect(legacy.status).toBe(200);
  });

  it("rejects every callback except the registered native callback", async () => {
    for (const redirectUri of ["https://attacker.example/callback", "otherapp://auth/callback"]) {
      const url = authorizationUrl({ redirectUri });
      const response = await workerExports.default.fetch(new Request(url));
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain("text/html");
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM native_authorization_requests")
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("rejects every PKCE challenge method except S256", async () => {
    const response = await workerExports.default.fetch(new Request(authorizationUrl({ method: "plain" })));
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM native_authorization_requests")
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("requires PKCE, consumes the code once, and returns a 30-day opaque bearer", async () => {
    await insertAuthorizationCode();
    const wrong = await exchange("x".repeat(43));
    expect(wrong.status).toBe(400);

    const exchanged = await exchange(VERIFIER);
    expect(exchanged.status).toBe(200);
    const payload = await exchanged.json<{ accessToken: string; tokenType: string; expiresIn: number }>();
    expect(payload).toMatchObject({ tokenType: "Bearer", expiresIn: 2_592_000 });
    expect(payload.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const replay = await exchange(VERIFIER);
    expect(replay.status).toBe(400);
    const stored = await env.DB.prepare(`SELECT token_hash, scopes_json, allowed_identities_json, expires_at
      FROM native_sessions`).first<{
      token_hash: string; scopes_json: string; allowed_identities_json: string; expires_at: string;
    }>();
    expect(stored?.token_hash).toBe(await sha256(payload.accessToken));
    expect(stored?.token_hash).not.toBe(payload.accessToken);
    expect(JSON.parse(stored!.scopes_json)).toEqual([
      "account:read", "mail:read", "mail:write", "mail:send", "addresses:read",
    ]);
    expect(JSON.parse(stored!.allowed_identities_json)).toEqual([OWNER]);
    const lifetime = new Date(`${stored!.expires_at}Z`).valueOf() - Date.now();
    expect(lifetime).toBeGreaterThan(2_591_900_000);
    expect(lifetime).toBeLessThanOrEqual(2_592_000_000);
  });

  it("snapshots only native mail scopes and enabled identities even from an unrestricted administrator", async () => {
    await env.DB.prepare(`UPDATE api_keys SET scopes_json = '["*"]', allowed_identities_json = NULL WHERE id = ?`)
      .bind(KEY_ID).run();
    await insertAuthorizationCode();
    const exchanged = await exchange(VERIFIER);
    expect(exchanged.status).toBe(200);
    const { accessToken } = await exchanged.json<{ accessToken: string }>();
    const authenticated = await authenticateNativeSession(env as Env, accessToken);
    expect(JSON.parse(authenticated!.row.scopes_json)).toEqual([
      "account:read", "mail:read", "mail:write", "mail:send", "addresses:read",
    ]);
    expect(JSON.parse(authenticated!.row.allowed_identities_json!)).toContain(OWNER);
    expect(JSON.parse(authenticated!.row.scopes_json)).not.toContain("*");
    expect(JSON.parse(authenticated!.row.scopes_json)).not.toContain("keys:write");

    await env.DB.prepare(`INSERT INTO identities
      (address, display_name, zone_id, routing_rule_id)
      VALUES ('new-account@example.com', 'New Account', 'test-zone', 'test-rule')`).run();
    const expanded = await authenticateNativeSession(env as Env, accessToken);
    expect(JSON.parse(expanded!.row.allowed_identities_json!)).toContain("new-account@example.com");

    await env.DB.prepare(`UPDATE api_keys SET scopes_json = '["account:read","mail:read"]',
      allowed_identities_json = '["owner@example.com"]' WHERE id = ?`).bind(KEY_ID).run();
    const narrowed = await authenticateNativeSession(env as Env, accessToken);
    expect(JSON.parse(narrowed!.row.scopes_json)).toEqual(["account:read", "mail:read"]);
    expect(JSON.parse(narrowed!.row.allowed_identities_json!)).not.toContain("new-account@example.com");
  });

  it("accepts the native bearer on existing APIs without browser Origin and revokes only that session", async () => {
    await insertAuthorizationCode();
    const exchanged = await exchange(VERIFIER);
    const { accessToken } = await exchanged.json<{ accessToken: string }>();
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.60" };

    const whoami = await workerExports.default.fetch(new Request("https://mail.test/v1/whoami", { headers }));
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({ principal: { keyId: KEY_ID, name: "Native passkey" } });

    const mutation = await workerExports.default.fetch(new Request("https://mail.test/v1/drafts", {
      method: "PUT",
      headers,
      body: JSON.stringify({ from: OWNER, to: [], cc: [], bcc: [], subject: "Native", text: "Draft" }),
    }));
    expect(mutation.status).toBe(200);

    const logout = await workerExports.default.fetch(new Request("https://mail.test/auth/native/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "CF-Connecting-IP": "192.0.2.60" },
    }));
    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toEqual({ revoked: true });

    const afterLogout = await workerExports.default.fetch(new Request("https://mail.test/v1/whoami", { headers }));
    expect(afterLogout.status).toBe(401);
  });

  it("allows only one assertion-version claimant and never lowers the authenticator counter", async () => {
    const first = await claimWebAuthnAssertion(env as Env, CREDENTIAL_ID, 0, 9);
    const stale = await claimWebAuthnAssertion(env as Env, CREDENTIAL_ID, 0, 10);
    const monotonic = await claimWebAuthnAssertion(env as Env, CREDENTIAL_ID, 1, 4);
    expect({ first, stale, monotonic }).toEqual({ first: true, stale: false, monotonic: true });
    const credential = await env.DB.prepare(`SELECT counter, assertion_version FROM webauthn_credentials WHERE id = ?`)
      .bind(CREDENTIAL_ID).first<{ counter: number; assertion_version: number }>();
    expect(credential).toEqual({ counter: 9, assertion_version: 2 });
  });

  it("does not allow native or browser sessions to start or finish passkey enrollment", async () => {
    await insertAuthorizationCode();
    const exchanged = await exchange(VERIFIER);
    const { accessToken } = await exchanged.json<{ accessToken: string }>();
    for (const path of ["options", "verify"]) {
      const native = await workerExports.default.fetch(new Request(
        `https://mail.example.com/auth/passkeys/register/${path}`,
        { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
      ));
      expect(native.status).toBe(403);
    }

    const webToken = "w".repeat(43);
    await env.DB.prepare(`INSERT INTO web_sessions (token_hash, credential_id, key_id, expires_at)
      VALUES (?, ?, ?, datetime('now', '+1 hour'))`).bind(await sha256(webToken), CREDENTIAL_ID, KEY_ID).run();
    for (const path of ["options", "verify"]) {
      const browser = await workerExports.default.fetch(new Request(
        `https://mail.example.com/auth/passkeys/register/${path}`,
        { method: "POST", headers: { Cookie: `__Host-lmail-session=${webToken}`, Origin: "https://mail.example.com" } },
      ));
      expect(browser.status).toBe(403);
    }
  });
});

function authorizationUrl(overrides: { redirectUri?: string; method?: string } = {}): URL {
  const url = new URL("https://mail.example.com/auth/native/authorize");
  url.searchParams.set("redirect_uri", overrides.redirectUri ?? CALLBACK_URI);
  url.searchParams.set("state", "s".repeat(43));
  url.searchParams.set("code_challenge", "x".repeat(43));
  url.searchParams.set("code_challenge_method", overrides.method ?? "S256");
  url.searchParams.set("platform", "ios");
  return url;
}

async function insertAuthorizationCode(): Promise<void> {
  await env.DB.prepare(`INSERT INTO native_authorization_codes
    (code_hash, credential_id, key_id, redirect_uri, code_challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+5 minutes'))`).bind(
    await sha256(CODE),
    CREDENTIAL_ID,
    KEY_ID,
    CALLBACK_URI,
    await sha256(VERIFIER),
  ).run();
}

async function exchange(codeVerifier: string): Promise<Response> {
  return workerExports.default.fetch(new Request("https://mail.test/auth/native/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.50" },
    body: JSON.stringify({ code: CODE, redirectUri: CALLBACK_URI, codeVerifier }),
  }));
}
