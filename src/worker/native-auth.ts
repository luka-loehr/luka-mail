import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { z } from "zod";
import { authenticateNativeSession, constrainedNativeSessionPolicy } from "./auth";
import { appName, mailHost } from "./config";
import { randomToken, sha256 } from "./crypto";
import type { ApiKeyRow, Env } from "./types";
import { claimWebAuthnAssertion } from "./webauthn-assertion";

type NativeAuthorizationRow = {
  id: string;
  challenge: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  platform: "ios" | "macos";
  expires_at: string;
};

type NativeAuthorizationCodeRow = {
  code_hash: string;
  credential_id: string;
  key_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: string;
};

type CredentialRow = {
  id: string;
  key_id: string;
  public_key: string;
  counter: number;
  assertion_version: number;
  transports_json: string;
};

const CALLBACK_URIS = ["lmail://auth/callback", "lukamail://auth/callback"] as const;
const AUTHORIZATION_MINUTES = 5;
const CODE_MINUTES = 5;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const authorizationQuery = z.object({
  redirect_uri: z.enum(CALLBACK_URIS),
  state: z.string().min(32).max(128).regex(BASE64URL),
  code_challenge: z.string().regex(PKCE_CHALLENGE),
  code_challenge_method: z.literal("S256"),
  platform: z.enum(["ios", "macos"]),
});

const verifyBody = z.object({
  authorizationId: z.string().min(20).max(128).regex(BASE64URL),
  response: z.unknown(),
});

const tokenBody = z.object({
  code: z.string().length(43).regex(BASE64URL),
  redirectUri: z.enum(CALLBACK_URIS),
  codeVerifier: z.string().regex(PKCE_VERIFIER),
});

export const nativeAuth = new Hono<{ Bindings: Env }>();

nativeAuth.get("/authorize", async (c) => {
  const name = appName(c.env);
  const input = authorizationQuery.safeParse(c.req.query());
  if (!input.success) return authorizationErrorPage("This authorization request is invalid or incomplete.", 400, name);
  const context = relyingParty(c.req.raw, c.env);
  if (!context) return authorizationErrorPage("Native authorization is unavailable on this host.", 400, name);

  const credentials = await c.env.DB.prepare(`SELECT id, transports_json FROM webauthn_credentials
    ORDER BY created_at`).all<{ id: string; transports_json: string }>();
  if (credentials.results.length === 0) {
    return authorizationErrorPage(`No passkey has been enrolled for ${name}.`, 409, name);
  }

  const options = await generateAuthenticationOptions({
    rpID: context.rpID,
    timeout: 60_000,
    userVerification: "required",
    allowCredentials: credentials.results.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports_json),
    })),
  });
  const authorizationId = randomToken(24);
  await c.env.DB.prepare(`INSERT INTO native_authorization_requests
    (id, challenge, redirect_uri, state, code_challenge, platform, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`).bind(
    authorizationId,
    options.challenge,
    input.data.redirect_uri,
    input.data.state,
    input.data.code_challenge,
    input.data.platform,
    `+${AUTHORIZATION_MINUTES} minutes`,
  ).run();

  return c.html(authorizationPage(authorizationId, options, name));
});

nativeAuth.post("/verify", async (c) => {
  const input = verifyBody.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid native passkey response" }, 400);
  const responseId = z.object({ id: z.string().min(1).max(1024) }).safeParse(input.data.response);
  if (!responseId.success) return c.json({ error: "Invalid native passkey response" }, 400);
  const response = input.data.response as AuthenticationResponseJSON;
  const [authorization, credential] = await Promise.all([
    consumeAuthorizationRequest(c.env, input.data.authorizationId),
    c.env.DB.prepare(`SELECT wc.id, wc.key_id, wc.public_key, wc.counter, wc.assertion_version,
        wc.transports_json
      FROM webauthn_credentials wc JOIN api_keys k ON k.id = wc.key_id
      WHERE wc.id = ? AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`).bind(responseId.data.id).first<CredentialRow>(),
  ]);
  const context = relyingParty(c.req.raw, c.env);
  if (!authorization || !credential || !context) {
    return c.json({ error: "Authorization expired or passkey unknown" }, 401);
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: authorization.challenge,
      expectedOrigin: context.origin,
      expectedRPID: context.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: base64UrlToBytes(credential.public_key),
        counter: credential.counter,
        transports: parseTransports(credential.transports_json),
      },
    });
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      return c.json({ error: "Passkey authentication failed" }, 401);
    }
    const claimed = await claimWebAuthnAssertion(c.env, credential.id, credential.assertion_version,
      verification.authenticationInfo.newCounter);
    if (!claimed) return c.json({ error: "Passkey was used concurrently; start authorization again" }, 409);

    const code = randomToken(32);
    await c.env.DB.prepare(`INSERT INTO native_authorization_codes
      (code_hash, credential_id, key_id, redirect_uri, code_challenge, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))`).bind(
      await sha256(code),
      credential.id,
      credential.key_id,
      authorization.redirect_uri,
      authorization.code_challenge,
      `+${CODE_MINUTES} minutes`,
    ).run();
    const callback = new URL(authorization.redirect_uri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", authorization.state);
    return c.json({ redirectTo: callback.toString() });
  } catch (error) {
    console.warn(JSON.stringify({ event: "native-passkey-authentication-rejected", credentialId: response.id,
      error: String(error).slice(0, 500) }));
    return c.json({ error: "Passkey authentication failed" }, 401);
  }
});

nativeAuth.post("/token", async (c) => {
  const input = tokenBody.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid authorization code exchange" }, 400);
  const codeHash = await sha256(input.data.code);
  const code = await c.env.DB.prepare(`SELECT ac.* FROM native_authorization_codes ac
    JOIN api_keys k ON k.id = ac.key_id
    WHERE ac.code_hash = ? AND ac.redirect_uri = ? AND ac.expires_at > CURRENT_TIMESTAMP
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`)
    .bind(codeHash, input.data.redirectUri).first<NativeAuthorizationCodeRow>();
  if (!code || !await constantTimeEqual(await sha256(input.data.codeVerifier), code.code_challenge)) {
    return c.json({ error: "Authorization code is invalid, expired, or PKCE verification failed" }, 400);
  }
  const parent = await c.env.DB.prepare(`SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`).bind(code.key_id).first<ApiKeyRow>();
  if (!parent) return c.json({ error: "Authorization is no longer active" }, 400);
  const policy = await constrainedNativeSessionPolicy(c.env, parent);
  if (policy.scopes.length === 0 || policy.allowedIdentities.length === 0) {
    return c.json({ error: "No native mail access is available for this passkey" }, 403);
  }
  const consumed = await c.env.DB.prepare(`DELETE FROM native_authorization_codes
    WHERE code_hash = ? AND code_challenge = ?`).bind(codeHash, code.code_challenge).run();
  if (consumed.meta.changes !== 1) return c.json({ error: "Authorization code has already been used" }, 400);

  const accessToken = randomToken(32);
  await c.env.DB.prepare(`INSERT INTO native_sessions
    (token_hash, credential_id, key_id, scopes_json, allowed_identities_json, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))`).bind(
    await sha256(accessToken),
    code.credential_id,
    code.key_id,
    JSON.stringify(policy.scopes),
    JSON.stringify(policy.allowedIdentities),
    `+${SESSION_SECONDS} seconds`,
  ).run();
  return c.json({ accessToken, tokenType: "Bearer" as const, expiresIn: SESSION_SECONDS });
});

nativeAuth.post("/logout", async (c) => {
  const authorization = c.req.header("Authorization") ?? "";
  const token = /^Bearer (.+)$/.exec(authorization)?.[1] ?? "";
  const session = await authenticateNativeSession(c.env, token);
  if (!session) return c.json({ error: "A valid native session is required" }, 401, { "WWW-Authenticate": "Bearer" });
  const result = await c.env.DB.prepare("DELETE FROM native_sessions WHERE token_hash = ?")
    .bind(await sha256(token)).run();
  return c.json({ revoked: result.meta.changes === 1 });
});

async function consumeAuthorizationRequest(env: Env, id: string): Promise<NativeAuthorizationRow | null> {
  const authorization = await env.DB.prepare(`SELECT * FROM native_authorization_requests
    WHERE id = ? AND expires_at > CURRENT_TIMESTAMP`).bind(id).first<NativeAuthorizationRow>();
  if (!authorization) return null;
  const deleted = await env.DB.prepare("DELETE FROM native_authorization_requests WHERE id = ? AND challenge = ?")
    .bind(id, authorization.challenge).run();
  return deleted.meta.changes === 1 ? authorization : null;
}

function authorizationPage(authorizationId: string, options: unknown, name: string): string {
  const safeName = escapeHtml(name);
  const serializedName = safeScriptJson(name);
  const serializedId = safeScriptJson(authorizationId);
  const serializedOptions = safeScriptJson(options);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>Authorize ${safeName}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f2f2f5; color: #17171a; }
    main { width: min(100%, 420px); padding: 36px; border: 1px solid rgba(0,0,0,.08); border-radius: 24px; background: rgba(255,255,255,.9); box-shadow: 0 22px 70px rgba(0,0,0,.12); text-align: center; }
    .icon { width: 56px; height: 56px; margin: 0 auto 22px; display: grid; place-items: center; border-radius: 17px; background: #151518; color: white; font-size: 26px; }
    h1 { margin: 0; font-size: 25px; letter-spacing: -.035em; }
    p { margin: 12px 0 0; color: #68686f; font-size: 15px; line-height: 1.5; }
    button { width: 100%; margin-top: 28px; border: 0; border-radius: 13px; padding: 14px 18px; background: #151518; color: white; font: inherit; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    #error { min-height: 20px; color: #b42318; font-size: 13px; }
    @media (prefers-color-scheme: dark) {
      body { background: #0c0c0e; color: #f7f7f8; }
      main { border-color: rgba(255,255,255,.1); background: rgba(27,27,30,.94); box-shadow: 0 22px 70px rgba(0,0,0,.4); }
      .icon, button { background: #f5f5f7; color: #151518; }
      p { color: #aaaab1; }
      #error { color: #ff8a80; }
    }
  </style>
</head>
<body>
  <main>
    <div class="icon" aria-hidden="true">&#9993;</div>
    <h1>Authorize ${safeName}</h1>
    <p>Confirm your passkey to securely connect this device for 30 days.</p>
    <button id="authorize" type="button">Continue with passkey</button>
    <p id="status" role="status">A private, revocable session is created for this app only.</p>
    <p id="error" role="alert"></p>
  </main>
  <script>
    const appName = ${serializedName};
    const authorizationId = ${serializedId};
    const options = ${serializedOptions};
    const button = document.getElementById("authorize");
    const status = document.getElementById("status");
    const error = document.getElementById("error");
    function decode(value) {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
      const binary = atob(base64);
      return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
    }
    function encode(value) {
      const bytes = new Uint8Array(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    }
    async function authorize() {
      button.disabled = true;
      status.textContent = "Waiting for your passkey…";
      error.textContent = "";
      try {
        const publicKey = {
          ...options,
          challenge: decode(options.challenge),
          allowCredentials: (options.allowCredentials || []).map(item => ({ ...item, id: decode(item.id) })),
        };
        const credential = await navigator.credentials.get({ publicKey });
        if (!credential) throw new Error("No passkey response was returned.");
        const response = credential.response;
        const payload = {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment || undefined,
          clientExtensionResults: credential.getClientExtensionResults(),
          response: {
            authenticatorData: encode(response.authenticatorData),
            clientDataJSON: encode(response.clientDataJSON),
            signature: encode(response.signature),
            userHandle: response.userHandle ? encode(response.userHandle) : undefined,
          },
        };
        const verification = await fetch("/auth/native/verify", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authorizationId, response: payload }),
        });
        const result = await verification.json();
        if (!verification.ok || !result.redirectTo) throw new Error(result.error || "Authorization failed.");
        status.textContent = "Authorized. Returning to " + appName + "…";
        window.location.assign(result.redirectTo);
      } catch (cause) {
        status.textContent = "Authorization was not completed.";
        error.textContent = cause instanceof Error && cause.name !== "NotAllowedError"
          ? cause.message : "Passkey confirmation was cancelled.";
        button.disabled = false;
      }
    }
    button.addEventListener("click", authorize);
  </script>
</body>
</html>`;
}

function authorizationErrorPage(message: string, status: 400 | 409, name: string): Response {
  const safeMessage = escapeHtml(message);
  const safeName = escapeHtml(name);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark"><title>Authorization unavailable</title><style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#f2f2f5}main{max-width:420px;padding:32px;border-radius:22px;background:Canvas;text-align:center;box-shadow:0 20px 60px #0002}h1{font-size:24px}p{color:GrayText;line-height:1.5}</style></head>
    <body><main><h1>Authorization unavailable</h1><p>${safeMessage}</p><p>You can close this window and try again from ${safeName}.</p></main></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

function relyingParty(request: Request, env: Env): { origin: string; rpID: string } | null {
  const url = new URL(request.url);
  const configuredHost = mailHost(env);
  if (configuredHost && url.hostname.toLowerCase() === configuredHost && url.protocol === "https:") {
    return { origin: url.origin, rpID: url.hostname };
  }
  const host = (request.headers.get("Host") ?? url.host).split(":")[0].toLowerCase();
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) {
    return { origin: `http://${request.headers.get("Host") ?? url.host}`, rpID: host };
  }
  return null;
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed as AuthenticatorTransportFuture[] : [];
  } catch {
    return [];
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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
