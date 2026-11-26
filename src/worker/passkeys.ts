import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authenticateWebSession, cookieValue, requireApiKey, securityHeaders, type ApiVariables } from "./auth";
import { appName, mailHost } from "./config";
import { randomToken, sha256 } from "./crypto";
import { nativeAuth } from "./native-auth";
import type { Env } from "./types";
import { claimWebAuthnAssertion } from "./webauthn-assertion";

type PasskeyApp = { Bindings: Env; Variables: ApiVariables };
type ChallengeRow = { id: string; challenge: string; kind: string; key_id: string | null; webauthn_user_id: string | null; expires_at: string };
type CredentialRow = { id: string; key_id: string; webauthn_user_id: string; public_key: string; counter: number; assertion_version: number; device_type: string; backed_up: number; transports_json: string };

const SESSION_COOKIE = "__Host-lmail-session";
const SESSION_HOURS = 12;
const CHALLENGE_MINUTES = 5;

export const passkeys = new Hono<PasskeyApp>();
passkeys.use("*", securityHeaders);
passkeys.use("*", async (c, next) => {
  const limited = await c.env.AUTH_RATE_LIMITER.limit({ key: `passkey:${c.req.header("CF-Connecting-IP") ?? "unknown"}` });
  if (!limited.success) return c.json({ error: "Too many authentication attempts" }, 429, { "Retry-After": "60" });
  await next();
});
passkeys.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Authentication payload is too large" }, 413) }));
passkeys.route("/native", nativeAuth);

const requireStaticApiKey: import("hono").MiddlewareHandler<PasskeyApp> = async (c, next) => {
  if (c.get("authMethod") !== "api-key") {
    return c.json({ error: "Passkey enrollment requires an administrator API key" }, 403);
  }
  await next();
};

passkeys.get("/status", async (c) => {
  const [session, credentialCount] = await Promise.all([
    authenticateWebSession(c.env, cookieValue(c.req.header("Cookie"), SESSION_COOKIE)),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM webauthn_credentials").first<{ count: number }>(),
  ]);
  return c.json({ authenticated: Boolean(session), setupRequired: (credentialCount?.count ?? 0) === 0,
    principal: session ? principalFromRow(session.row) : null });
});

passkeys.post("/passkeys/register/options", requireApiKey, requireStaticApiKey, async (c) => {
  const context = relyingParty(c.req.raw, c.env);
  if (!context) return c.json({ error: "Passkey enrollment is unavailable on this host" }, 400);
  const principal = c.get("principal");
  const credentials = await c.env.DB.prepare("SELECT id, transports_json FROM webauthn_credentials WHERE key_id = ?")
    .bind(principal.keyId).all<{ id: string; transports_json: string }>();
  const userId = randomToken(32);
  const options = await generateRegistrationOptions({
    rpName: appName(c.env), rpID: context.rpID, userName: c.env.OWNER_EMAIL, userDisplayName: principal.name,
    userID: base64UrlToBytes(userId), attestationType: "none", timeout: 60_000,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: credentials.results.map((credential) => ({ id: credential.id, transports: parseTransports(credential.transports_json) })),
  });
  const challengeId = randomToken(24);
  await c.env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, kind, key_id, webauthn_user_id, expires_at)
    VALUES (?, ?, 'registration', ?, ?, datetime('now', ?))`).bind(challengeId, options.challenge, principal.keyId, userId, `+${CHALLENGE_MINUTES} minutes`).run();
  return c.json({ challengeId, options });
});

passkeys.post("/passkeys/register/verify", requireApiKey, requireStaticApiKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const input = z.object({ challengeId: z.string().min(20).max(128), name: z.string().trim().min(1).max(80).default("Passkey"), response: z.unknown() }).safeParse(body);
  if (!input.success) return c.json({ error: "Invalid passkey registration response" }, 400);
  const challenge = await consumeChallenge(c.env, input.data.challengeId, "registration");
  if (!challenge || challenge.key_id !== c.get("principal").keyId || !challenge.webauthn_user_id) return c.json({ error: "Registration challenge expired" }, 400);
  const context = relyingParty(c.req.raw, c.env);
  if (!context) return c.json({ error: "Passkey enrollment is unavailable on this host" }, 400);
  try {
    const verification = await verifyRegistrationResponse({ response: input.data.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge, expectedOrigin: context.origin, expectedRPID: context.rpID,
      requireUserPresence: true, requireUserVerification: true });
    if (!verification.verified) return c.json({ error: "Passkey registration could not be verified" }, 400);
    const info = verification.registrationInfo;
    await c.env.DB.prepare(`INSERT INTO webauthn_credentials
      (id, key_id, webauthn_user_id, public_key, counter, device_type, backed_up, transports_json, name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(info.credential.id, challenge.key_id, challenge.webauthn_user_id, bytesToBase64Url(info.credential.publicKey),
        info.credential.counter, info.credentialDeviceType, Number(info.credentialBackedUp), JSON.stringify(info.credential.transports ?? []), input.data.name).run();
    return c.json({ registered: true });
  } catch (error) {
    console.warn("Passkey registration rejected", { error: String(error).slice(0, 500) });
    return c.json({ error: "Passkey registration could not be verified" }, 400);
  }
});

passkeys.post("/passkeys/login/options", async (c) => {
  const context = relyingParty(c.req.raw, c.env);
  if (!context) return c.json({ error: "Passkey login is unavailable on this host" }, 400);
  const credentials = await c.env.DB.prepare("SELECT id, transports_json FROM webauthn_credentials ORDER BY created_at").all<{ id: string; transports_json: string }>();
  if (credentials.results.length === 0) return c.json({ error: "No passkey has been enrolled", setupRequired: true }, 409);
  const options = await generateAuthenticationOptions({ rpID: context.rpID, timeout: 60_000, userVerification: "required",
    allowCredentials: credentials.results.map((credential) => ({ id: credential.id, transports: parseTransports(credential.transports_json) })) });
  const challengeId = randomToken(24);
  await c.env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, kind, expires_at)
    VALUES (?, ?, 'authentication', datetime('now', ?))`).bind(challengeId, options.challenge, `+${CHALLENGE_MINUTES} minutes`).run();
  return c.json({ challengeId, options });
});

passkeys.post("/passkeys/login/verify", async (c) => {
  const input = z.object({ challengeId: z.string().min(20).max(128), response: z.unknown() }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid passkey authentication response" }, 400);
  // The credential id is read before verification: it must be there, and a string.
  if (!z.object({ id: z.string().min(1).max(1024) }).safeParse(input.data.response).success) {
    return c.json({ error: "Invalid passkey authentication response" }, 400);
  }
  const response = input.data.response as AuthenticationResponseJSON;
  const [challenge, credential] = await Promise.all([
    consumeChallenge(c.env, input.data.challengeId, "authentication"),
    c.env.DB.prepare("SELECT * FROM webauthn_credentials WHERE id = ?").bind(response.id).first<CredentialRow>(),
  ]);
  const context = relyingParty(c.req.raw, c.env);
  if (!challenge || !credential || !context) return c.json({ error: "Authentication challenge expired or credential unknown" }, 401);
  try {
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
      expectedOrigin: context.origin, expectedRPID: context.rpID, requireUserVerification: true,
      credential: { id: credential.id, publicKey: base64UrlToBytes(credential.public_key), counter: credential.counter,
        transports: parseTransports(credential.transports_json) } });
    if (!verification.verified || !verification.authenticationInfo.userVerified) return c.json({ error: "Passkey authentication failed" }, 401);
    const claimed = await claimWebAuthnAssertion(c.env, credential.id, credential.assertion_version,
      verification.authenticationInfo.newCounter);
    if (!claimed) return c.json({ error: "Passkey was used concurrently; start sign-in again" }, 409);
    const token = randomToken(32);
    const tokenHash = await sha256(token);
    await c.env.DB.prepare(`INSERT INTO web_sessions (token_hash, credential_id, key_id, expires_at)
      VALUES (?, ?, ?, datetime('now', ?))`).bind(tokenHash, credential.id, credential.key_id, `+${SESSION_HOURS} hours`).run();
    c.header("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict`);
    return c.json({ authenticated: true });
  } catch (error) {
    console.warn("Passkey authentication rejected", { credentialId: response.id, error: String(error).slice(0, 500) });
    return c.json({ error: "Passkey authentication failed" }, 401);
  }
});

passkeys.post("/logout", async (c) => {
  const token = cookieValue(c.req.header("Cookie"), SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM web_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
  return c.json({ authenticated: false });
});

async function consumeChallenge(env: Env, id: string, kind: string): Promise<ChallengeRow | null> {
  const challenge = await env.DB.prepare(`SELECT * FROM webauthn_challenges WHERE id = ? AND kind = ? AND expires_at > CURRENT_TIMESTAMP`)
    .bind(id, kind).first<ChallengeRow>();
  if (!challenge) return null;
  const deleted = await env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ? AND challenge = ?").bind(id, challenge.challenge).run();
  return deleted.meta.changes === 1 ? challenge : null;
}

function relyingParty(request: Request, env: Env): { origin: string; rpID: string } | null {
  const url = new URL(request.url);
  const host = mailHost(env);
  if (host && url.hostname.toLowerCase() === host && url.protocol === "https:") return { origin: url.origin, rpID: url.hostname };
  const forwardedHost = (request.headers.get("Host") ?? "").split(":")[0].toLowerCase();
  if (url.protocol === "http:" && (forwardedHost === "localhost" || forwardedHost === "127.0.0.1")) {
    const browserOrigin = `http://${request.headers.get("Host")}`;
    return { origin: browserOrigin, rpID: forwardedHost };
  }
  return null;
}

function principalFromRow(row: { id: string; name: string; scopes_json: string; allowed_identities_json: string | null }) {
  return { keyId: row.id, name: row.name, scopes: parseStrings(row.scopes_json),
    allowedIdentities: row.allowed_identities_json === null ? null : parseStrings(row.allowed_identities_json) };
}

function parseStrings(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; }
  catch { return []; }
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
  return parseStrings(value) as AuthenticatorTransportFuture[];
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
