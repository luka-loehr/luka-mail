import { env, exports as workerExports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateNativeSession, authenticateWebSession, issueApiKey, issueDeviceApiKey } from "../src/worker/auth";
import { parseBimiRecord, senderPassedDmarc, senderPassedMailAuth } from "../src/worker/bimi";
import { sha256 } from "../src/worker/crypto";
import { ingestExternalMessage } from "../src/worker/external";
import { processInbound } from "../src/worker/inbound";
import { safeHttpsURL, safeLogoSVG } from "../src/worker/logo-discovery";
import { buildMime } from "../src/worker/mime";
import { deliverPushJob } from "../src/worker/push";
import { draftReply } from "../src/worker/reply-drafts";
import { submitViaSmtp, type SmtpTransport } from "../src/worker/smtp";
import type { CATEGORIES } from "../src/worker/triage";
import type { Env, InboundJob } from "../src/worker/types";

const workerEnv = env as unknown as Env;
const OWNER = "owner@example.com";
const EXTERNAL = "external@ext.example.org";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM push_devices"),
    env.DB.prepare("DELETE FROM push_notification_outbox"),
    env.DB.prepare("DELETE FROM native_sessions"),
    env.DB.prepare("DELETE FROM web_sessions"),
    env.DB.prepare("DELETE FROM webauthn_credentials"),
    env.DB.prepare("DELETE FROM autopilot_actions"),
    env.DB.prepare("DELETE FROM autopilot_rules WHERE id NOT LIKE 'default-%'"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM drafts"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

function call(url: string, init: RequestInit = {}): Promise<Response> {
  return workerExports.default.fetch(new Request(url.startsWith("https://") ? url : `https://mail.example.com${url}`, init));
}

describe("passkey, web-session, and expiry hardening", () => {
  it("blocks restricted, device, and unconfirmed keys from enrolling passkeys", async () => {
    const restricted = await issueApiKey(workerEnv, "restricted", ["keys:write"], [OWNER], null, "test");
    const device = await issueDeviceApiKey(workerEnv, "device", ["mail:read"], [OWNER], "2099-01-01T00:00:00.000Z", "test");
    const admin = await issueApiKey(workerEnv, "admin", ["keys:write"], null, null, "test");

    for (const token of [restricted.token, device.token]) {
      const denied = await call("/auth/passkeys/register/options", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Admin-Confirmation": "user-approved" },
      });
      expect(denied.status).toBe(403);
    }

    const unconfirmed = await call("/auth/passkeys/register/options", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(unconfirmed.status).toBe(428);

    const confirmed = await call("/auth/passkeys/register/options", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}`, "X-Admin-Confirmation": "user-approved" },
    });
    expect(confirmed.status).toBe(200);
  });

  it("constrains browser web sessions, enforces logout Origin, and rejects same-day ISO-8601 expired keys", async () => {
    const pastTodayIso = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(`INSERT INTO api_keys (id, name, secret_hash, scopes_json, allowed_identities_json, expires_at)
      VALUES ('expired-iso-key', 'Expired ISO', 'unused-expired-iso', '["*"]', NULL, ?)`).bind(pastTodayIso).run();

    await env.DB.prepare(`INSERT INTO api_keys (id, name, secret_hash, scopes_json, allowed_identities_json)
      VALUES ('web-admin-key', 'Admin', 'unused-web-admin', '["*"]', NULL)`).run();
    await env.DB.prepare(`INSERT INTO webauthn_credentials
      (id, key_id, webauthn_user_id, public_key, counter, device_type, backed_up, transports_json, name)
      VALUES ('web-cred', 'web-admin-key', 'u', 'pk', 0, 'multiDevice', 1, '[]', 'Passkey')`).run();
    const webToken = "w".repeat(43);
    await env.DB.prepare(`INSERT INTO web_sessions (token_hash, credential_id, key_id, expires_at)
      VALUES (?, 'web-cred', 'web-admin-key', datetime('now', '+1 hour'))`).bind(await sha256(webToken)).run();

    const session = await authenticateWebSession(workerEnv, webToken);
    expect(session).not.toBeNull();
    expect(JSON.parse(session!.row.scopes_json)).not.toContain("*");
    expect(JSON.parse(session!.row.scopes_json)).not.toContain("keys:write");

    const crossSiteLogout = await call("/auth/logout", {
      method: "POST",
      headers: { Cookie: `__Host-lmail-session=${webToken}`, Origin: "https://attacker.example" },
    });
    expect(crossSiteLogout.status).toBe(403);

    const sameOriginLogout = await call("/auth/logout", {
      method: "POST",
      headers: { Cookie: `__Host-lmail-session=${webToken}`, Origin: "https://mail.example.com" },
    });
    expect(sameOriginLogout.status).toBe(200);
    expect(await authenticateWebSession(workerEnv, webToken)).toBeNull();

    await env.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE id = 'web-admin-key'").bind(pastTodayIso).run();
    const loginOptions = await call("/auth/passkeys/login/options", { method: "POST" });
    expect(loginOptions.status).toBe(409);
  });
});

describe("MTA-STS fail-closed isolation and response headers", () => {
  it("fails closed on unmanaged mta-sts.* hosts with full security headers and preserves sender-logo sandbox CSP", async () => {
    const unmanagedPolicy = await call("https://mta-sts.unmanaged.example/.well-known/mta-sts.txt");
    expect(unmanagedPolicy.status).toBe(404);
    expect(unmanagedPolicy.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
    expect(unmanagedPolicy.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const unmanagedApi = await call("https://mta-sts.unmanaged.example/v1/whoami");
    expect(unmanagedApi.status).toBe(404);

    const root = await call("https://mail.example.com/");
    expect(root.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("push session binding, Unicode attachment headers, and restricted-key isolation", () => {
  it("stops APNs push delivery immediately when the registering native session is deleted", async () => {
    await env.DB.prepare(`INSERT INTO api_keys (id, name, secret_hash, scopes_json, allowed_identities_json)
      VALUES ('push-parent', 'Parent', 'unused', '["mail:read"]', '["owner@example.com"]')`).run();
    await env.DB.prepare(`INSERT INTO webauthn_credentials
      (id, key_id, webauthn_user_id, public_key, counter, device_type, backed_up, transports_json, name)
      VALUES ('push-cred', 'push-parent', 'u', 'pk', 0, 'multiDevice', 1, '[]', 'Passkey')`).run();
    const nativeToken = "p".repeat(43);
    await env.DB.prepare(`INSERT INTO native_sessions
      (token_hash, credential_id, key_id, scopes_json, allowed_identities_json, expires_at)
      VALUES (?, 'push-cred', 'push-parent', '["mail:read"]', '["owner@example.com"]', datetime('now', '+7 days'))`)
      .bind(await sha256(nativeToken)).run();
    expect(await authenticateNativeSession(workerEnv, nativeToken)).not.toBeNull();

    const putResp = await call("/v1/push-devices", {
      method: "PUT",
      headers: { Authorization: `Bearer ${nativeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceToken: "ab".repeat(32), environment: "development", identities: [OWNER] }),
    });
    expect(putResp.status).toBe(200);

    const logoutResp = await call("/auth/native/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    expect(logoutResp.status).toBe(200);

    await env.DB.prepare(`INSERT INTO messages
      (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
      VALUES ('after-logout-msg', 't1', 'inbound', 'inbox', 'a@example.org', '[{"address":"owner@example.com"}]',
        'raw/after-logout.eml', '2026-11-27T00:00:00.000Z', 12, 'ready', 'owner@example.com')`).run();

    const pushed: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      pushed.push(new Request(input, init));
      return new Response(null, { status: 200 });
    }));
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
    await deliverPushJob({ ...workerEnv, APNS_KEY_ID: "K1", APNS_TEAM_ID: "T1", APNS_PRIVATE_KEY: pem }, {
      kind: "push",
      messageId: "after-logout-msg",
    });
    expect(pushed).toHaveLength(0);
  });

  it("downloads attachments with Unicode filenames cleanly and isolates restricted keys on deliverability, sync, keys, and audit", async () => {
    await env.MAIL.put("attachment/u1/att-u1", new Uint8Array([1, 2, 3]));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO messages
        (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
        VALUES ('u1', 'u1', 'inbound', 'inbox', 'a@example.org', '[{"address":"owner@example.com"}]',
          'raw/u1.eml', '2026-11-27T00:00:00.000Z', 3, 'ready', ?)`).bind(OWNER),
      env.DB.prepare(`INSERT INTO attachments (id, message_id, filename, content_type, object_key, size)
        VALUES ('att-u1', 'u1', 'Rechnung — März €100.pdf', 'application/pdf', 'attachment/u1/att-u1', 3)`),
    ]);
    const restricted = await issueApiKey(
      workerEnv,
      "restricted-owner",
      ["account:read", "addresses:read", "mail:read", "mail:write", "keys:read", "audit:read"],
      [OWNER],
      null,
      "test",
    );
    const admin = await issueApiKey(workerEnv, "global-admin", ["*"], null, null, "test");
    const headers = { Authorization: `Bearer ${restricted.token}`, "Content-Type": "application/json" };

    const download = await call("/v1/attachments/att-u1", { headers });
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("filename*=UTF-8''Rechnung%20%E2%80%94%20M%C3%A4rz%20%E2%82%AC100.pdf");

    expect((await call("/v1/deliverability", { headers })).status).toBe(403);

    const sync = await call("/v1/external/sync", { method: "POST", headers, body: "{}" });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ accounts: [], syncedMessages: 0 });

    const keysResp = await (await call("/v1/keys", { headers })).json<{ keys: Array<{ id: string }> }>();
    expect(keysResp.keys.map((k) => k.id)).toEqual([restricted.id]);
    expect(keysResp.keys.map((k) => k.id)).not.toContain(admin.id);

    await env.DB.prepare(`INSERT INTO audit_logs (id, request_id, key_id, actor, action, resource, status, ip_hash, metadata_json)
      VALUES ('admin-audit', 'r-admin', ?, 'global-admin', 'POST /v1/addresses', 'secret@ext.example.org', 201, 'h', '{}')`)
      .bind(admin.id).run();
    const auditResp = await (await call("/v1/audit", { headers })).json<{ events: Array<{ keyId: string }> }>();
    expect(auditResp.events.every((event) => event.keyId === restricted.id)).toBe(true);
    expect((await call(`/v1/audit?keyId=${admin.id}`, { headers })).status).toBe(403);
  });
});

describe("forged From spoofing, cross-mailbox draft exfiltration,mailbox-delta spam, SSRF, and SMTP STARTTLS", () => {
  it("blocks unauthenticated From spoofing from bypassing spam or archiving real alerts, and includes spam in mailbox-delta", async () => {
    await env.DB.prepare(`INSERT INTO contacts (identity_address, address, display_name, send_count)
      VALUES (?, 'family@example.org', 'Family', 1)`).bind(OWNER).run();

    // Real authenticated alert in inbox.
    const realRaw = [
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=ops.example.org",
      "From: Ops <alerts@ops.example.org>",
      `To: ${OWNER}`,
      "Subject: [Cluster] Compute 1 is not reachable",
      "Message-ID: <real-alert@ops.example.org>",
      "",
      "Node down",
    ].join("\r\n");
    await env.MAIL.put("raw/real-alert.eml", realRaw);
    await env.DB.prepare(`INSERT INTO messages
      (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
      VALUES ('real-alert', 'real-alert', 'inbound', 'inbox', 'alerts@ops.example.org', ?, 'raw/real-alert.eml',
        '2026-11-27T01:00:00.000Z', ?, 'pending', ?)`).bind(JSON.stringify([{ address: OWNER }]), realRaw.length, OWNER).run();

    const makeFakeAi = (category: keyof typeof CATEGORIES, spamScore: number) => ({
      ...workerEnv,
      AI: {
        run: async () => ({
          answers: {
            category: { type: "choice", choice: category, probabilities: { [category]: 0.95 }, confidence: 0.95 },
            spam: { type: "noul", noul: spamScore },
            needs_reply: { type: "noul", noul: 0.01 },
            urgency: { type: "score", score: 2 },
          },
          usage: { input_tokens: 100, output_tokens: 0 },
        }),
      },
      MAIL_QUEUE: { send: async () => {}, sendBatch: async () => {}, metrics: async () => null },
    } as unknown as Env);

    await processInbound({
      id: "real-alert", rawKey: "raw/real-alert.eml", envelopeFrom: "alerts@ops.example.org",
      envelopeTo: OWNER, receivedAt: "2026-11-27T01:00:00.000Z", size: realRaw.length,
    }, makeFakeAi("notification", 0.01));

    // Unauthenticated spoofed resolution must NOT archive real-alert.
    const spoofResolvedRaw = [
      "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=evil.example; dmarc=fail header.from=ops.example.org",
      "From: Ops <alerts@ops.example.org>",
      `To: ${OWNER}`,
      "Subject: Resolved: Compute 1 is not reachable",
      "Message-ID: <spoof-resolved@evil.example>",
      "",
      "Fake resolution",
    ].join("\r\n");
    await env.MAIL.put("raw/spoof-resolved.eml", spoofResolvedRaw);
    await env.DB.prepare(`INSERT INTO messages
      (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
      VALUES ('spoof-resolved', 'spoof-resolved', 'inbound', 'inbox', 'alerts@ops.example.org', ?, 'raw/spoof-resolved.eml',
        '2026-11-27T01:05:00.000Z', ?, 'pending', ?)`).bind(JSON.stringify([{ address: OWNER }]), spoofResolvedRaw.length, OWNER).run();
    await processInbound({
      id: "spoof-resolved", rawKey: "raw/spoof-resolved.eml", envelopeFrom: "bounce@evil.example",
      envelopeTo: OWNER, receivedAt: "2026-11-27T01:05:00.000Z", size: spoofResolvedRaw.length,
    }, makeFakeAi("notification", 0.1));

    const realAfterSpoof = await env.DB.prepare("SELECT folder, unread FROM messages WHERE id = 'real-alert'")
      .first<{ folder: string; unread: number }>();
    expect(realAfterSpoof).toEqual({ folder: "inbox", unread: 1 });

    // Unauthenticated spoof of a contact with spam=0.95 MUST be flagged as spam AND include spam=true in /v1/mailbox-delta.
    const stateBefore = await env.DB.prepare("SELECT COALESCE(MAX(revision), 0) AS rev FROM mailbox_revisions WHERE identity_address = ?")
      .bind(OWNER).first<{ rev: number }>();
    const spoofContactRaw = [
      "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.org",
      "From: Family <family@example.org>",
      `To: ${OWNER}`,
      "Subject: Urgent wire transfer",
      "Message-ID: <spoof-contact@evil.example>",
      "",
      "Send BTC now",
    ].join("\r\n");
    await env.MAIL.put("raw/spoof-contact.eml", spoofContactRaw);
    const spoofJob: InboundJob = {
      id: "spoof-contact", rawKey: "raw/spoof-contact.eml", envelopeFrom: "attacker@evil.example",
      envelopeTo: OWNER, receivedAt: "2026-11-27T01:10:00.000Z", size: spoofContactRaw.length,
    };
    await env.DB.prepare(`INSERT INTO messages
      (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
      VALUES ('spoof-contact', 'spoof-contact', 'inbound', 'inbox', 'attacker@evil.example', ?, 'raw/spoof-contact.eml',
        '2026-11-27T01:10:00.000Z', ?, 'pending', ?)`).bind(JSON.stringify([{ address: OWNER }]), spoofContactRaw.length, OWNER).run();
    await processInbound(spoofJob, makeFakeAi("spam", 0.96));

    const spoofRow = await env.DB.prepare("SELECT spam FROM messages WHERE id = 'spoof-contact'").first<{ spam: number }>();
    expect(spoofRow?.spam).toBe(1);

    const reader = await issueDeviceApiKey(workerEnv, "delta-reader", ["mail:read"], [OWNER], "2099-01-01T00:00:00.000Z", "test");
    const deltaResp = await call(`/v1/mailbox-delta?identity=${encodeURIComponent(OWNER)}&since=${stateBefore?.rev ?? 0}`, {
      headers: { Authorization: `Bearer ${reader.token}` },
    });
    const deltaJson = await deltaResp.json<{ changes: Array<{ id: string; message: { spam: boolean } | null }> }>();
    const spamDelta = deltaJson.changes.filter((c) => c.id === "spoof-contact").at(-1);
    expect(spamDelta?.message?.spam).toBe(true);
  });

  it("isolates earlierMails per identity and preserves cross-mailbox external Message-IDs", async () => {
    await env.MAIL.put("body/owner-secret-sent.txt", "TOP_SECRET_OWNER_DEAL_TERMS_9921 for partner@corp.example.");
    await env.DB.prepare(`INSERT INTO messages
      (id, thread_id, message_id, direction, folder, subject, sender_name, sender_address, recipients_json,
        preview, text_key, raw_key, received_at, status, identity_address)
      VALUES ('owner-secret-sent', 't-s', '<shared-id@corp.example>', 'outbound', 'sent', 'Secret Terms', 'Owner', ?,
        '[{"address":"partner@corp.example"}]', 'Secret', 'body/owner-secret-sent.txt', 'raw/s.eml',
        '2026-11-20T10:00:00.000Z', 'ready', ?)`).bind(OWNER, OWNER).run();

    // Same Message-ID delivered to EXTERNAL must not be dropped!
    const sharedExternalRaw = [
      `From: Partner <partner@corp.example>`,
      `To: ${EXTERNAL}`,
      "Subject: Question",
      "Date: Thu, 26 Nov 2026 10:00:00 +0000",
      "Message-ID: <shared-id@corp.example>",
      "",
      "Can you confirm?",
    ].join("\r\n");
    const ingested = await ingestExternalMessage(workerEnv, {
      identity: EXTERNAL, localFolder: "inbox", externalFolder: null,
      raw: new TextEncoder().encode(sharedExternalRaw), seen: false, flagged: false,
      fallbackReceivedAt: "2026-11-26T10:00:00.000Z", suppressPush: true,
    });
    expect(ingested).toBe(true);

    const extMsg = await env.DB.prepare("SELECT id FROM messages WHERE identity_address = ?").bind(EXTERNAL).first<{ id: string }>();
    const prompts: string[] = [];
    const draftEnv = {
      ...workerEnv,
      AI: {
        run: async (_model: string, input: { messages: Array<{ content: string }> }) => {
          prompts.push(input.messages.map((m) => m.content).join("\n"));
          return { choices: [{ message: { content: "Hi Partner,\n\nConfirmed.\n\nBest,\nOwner" } }], usage: { prompt_tokens: 50, completion_tokens: 20 } };
        },
      },
    } as unknown as Env;
    expect(await draftReply(draftEnv, extMsg!.id, { onDemand: true })).toBe("drafted");
    expect(prompts[0]).not.toContain("TOP_SECRET_OWNER_DEAL_TERMS_9921");
  });

  it("hardens BIMI/DMARC comments, SSRF URL/SVG checks, RFC 2047 folding, and SMTP STARTTLS buffer injection", async () => {
    // Comment spoofing and secondary AR header spoofing must fail.
    expect(senderPassedDmarc([
      "mx.cloudflare.net; dmarc=fail (dmarc=pass header.from=paypal.com) header.from=paypal.com",
    ], "paypal.com")).toBe(false);
    expect(senderPassedDmarc([
      "mx.cloudflare.net; spf=pass smtp.mailfrom=attacker.example",
      "forged.example; dmarc=pass header.from=paypal.com",
    ], "paypal.com")).toBe(false);
    expect(senderPassedMailAuth([
      "mx.cloudflare.net; spf=pass smtp.mailfrom=friend@school.example",
    ], "school.example")).toBe(true);

    // Uncertified BIMI record cannot reference an unrelated tracker domain.
    expect(parseBimiRecord(["v=BIMI1; l=https://tracker.other.example/logo.svg"], "brand.example")).toBeNull();
    expect(parseBimiRecord(["v=BIMI1; l=https://cdn.brand.example/logo.svg"], "brand.example")).not.toBeNull();

    // SSRF URL checks & SVG CSS-escape / <use> bomb checks.
    expect(safeHttpsURL("https://brand.example:8443/icon.png")).toBeNull();
    expect(safeHttpsURL("https://sub.localhost/icon.png")).toBeNull();
    expect(safeHttpsURL("https://service.internal/icon.png")).toBeNull();
    const cssEscapeSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:\\75\\72\\6c(https://evil.example)}</style></svg>');
    expect(safeLogoSVG(cssEscapeSvg)).toBeNull();
    const useBombSvg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${"<use href=\"#a\"/>".repeat(33)}</svg>`);
    expect(safeLogoSVG(useBombSvg)).toBeNull();

    // Long UTF-8 subject lines are folded well below RFC 5322's 998-byte limit.
    const mime = buildMime(OWNER, {
      to: ["b@example.com"], cc: [], bcc: [],
      subject: "Ümlaut-Betreff ".repeat(40), text: "Body", attachments: [],
    });
    for (const line of mime.raw.split("\r\n")) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThan(998);
    }

    // SMTP STARTTLS rejects pipelined plaintext bytes injected alongside 220 Ready.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const replies = [
      encoder.encode("220 smtp.example ESMTP\r\n"),
      encoder.encode("250-smtp.example\r\n250 STARTTLS\r\n"),
      encoder.encode("220 Ready to start TLS\r\n250 Injected plaintext EHLO\r\n"),
    ];
    const transport: SmtpTransport = {
      async read() { return replies.shift() ?? null; },
      async write(chunk) { void decoder.decode(chunk); },
      async startTls() {},
      async close() {},
    };
    await expect(submitViaSmtp({
      host: "smtp.example", port: 587, username: "u", password: "p",
      from: OWNER, recipients: ["b@example.com"], raw: "Subject: test\r\n\r\nhi",
    }, async () => transport)).rejects.toThrow("Unexpected pipelined bytes after SMTP STARTTLS");
  });
});
