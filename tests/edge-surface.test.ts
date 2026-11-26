import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker/index";
import { cookieValue, issueApiKey } from "../src/worker/auth";
import { MTA_STS_POLICY } from "../src/worker/config";
import { isTrustedSender, readModelText } from "../src/worker/spam";
import type { Env } from "../src/worker/types";

const workerEnv = env as Env;
const OWNER = "owner@example.com";
const EXTERNAL = "external@ext.example.org";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM send_recipients"),
    env.DB.prepare("DELETE FROM send_requests"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
});

function call(url: string, init: RequestInit = {}): Promise<Response> {
  return workerExports.default.fetch(new Request(url.startsWith("https://") ? url : `https://mail.test${url}`, init));
}

describe("MTA-STS hosts", () => {
  it("serve the policy and nothing else", async () => {
    for (const host of ["mta-sts.example.com", "mta-sts.aws.example.com", "mta-sts.aws.example.org", "mta-sts.aws.example.net"]) {
      const policy = await call(`https://${host}/.well-known/mta-sts.txt`);
      expect(policy.status, host).toBe(200);
      expect(policy.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(await policy.text()).toBe(MTA_STS_POLICY);
    }
    expect(MTA_STS_POLICY).toContain("mode: enforce");
    for (const path of ["/", "/health", "/v1/whoami", "/auth/status", "/.well-known/mta-sts.txt/x"]) {
      expect((await call(`https://mta-sts.example.com${path}`)).status, path).toBe(404);
    }
    expect((await call("https://mta-sts.example.com/.well-known/mta-sts.txt", { method: "POST" })).status).toBe(404);
    // The API host does not serve the policy.
    expect((await call("https://mail.test/.well-known/mta-sts.txt")).status).toBe(404);
  });
});

describe("response headers", () => {
  it("sets the security headers and never caches dynamic responses", async () => {
    for (const path of ["/health", "/v1/whoami", "/auth/status", "/nothing-here"]) {
      const response = await call(path);
      expect(response.headers.get("Content-Security-Policy"), path).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
      expect(response.headers.get("Referrer-Policy"), path).toBe("no-referrer");
      expect(response.headers.get("Strict-Transport-Security"), path).toContain("max-age=63072000");
    }
    for (const path of ["/health", "/v1/whoami", "/auth/status"]) {
      expect((await call(path)).headers.get("Cache-Control"), path).toBe("no-store");
    }
    const unauthorized = await call("/v1/whoami");
    expect(unauthorized.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(unauthorized.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("/auth error paths", () => {
  const json = { "Content-Type": "application/json" };

  it("reports an anonymous browser without leaking a principal", async () => {
    const status = await call("/auth/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ authenticated: false, principal: null });
    const broken = await call("/auth/status", { headers: { Cookie: "__Host-lmail-session=%E0%A4%A" } });
    expect(broken.status).toBe(200);
    expect(await broken.json()).toMatchObject({ authenticated: false, principal: null });
  });

  it("answers 400 for malformed passkey and token bodies and 401 without a key or session", async () => {
    for (const path of ["/auth/passkeys/login/verify", "/auth/native/verify", "/auth/native/token"]) {
      expect((await call(path, { method: "POST", headers: json, body: "{not json" })).status, path).toBe(400);
      expect((await call(path, { method: "POST", headers: json, body: JSON.stringify({ challengeId: "short", code: "x" }) })).status, path).toBe(400);
    }
    // A well-formed challenge id with a missing or mistyped assertion is a client error, not a crash.
    for (const response of [undefined, null, "text", 7, {}, { id: 7 }, { id: { nested: true } }, { id: "" }]) {
      const verify = await call("/auth/passkeys/login/verify", { method: "POST", headers: json,
        body: JSON.stringify({ challengeId: "c".repeat(24), response }) });
      expect(verify.status, JSON.stringify(response)).toBe(400);
    }
    const unknown = await call("/auth/passkeys/login/verify", { method: "POST", headers: json,
      body: JSON.stringify({ challengeId: "c".repeat(24), response: { id: "unknown-credential" } }) });
    expect(unknown.status).toBe(401);
    expect((await call("/auth/passkeys/register/options", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
    expect((await call("/auth/passkeys/register/verify", { method: "POST", headers: json, body: "{}" })).status).toBe(401);
    expect((await call("/auth/native/logout", { method: "POST" })).status).toBe(401);
    expect((await call("/auth/native/logout", { method: "POST", headers: { Authorization: `Bearer ${"A".repeat(43)}` } })).status).toBe(401);
  });

  it("refuses an authentication payload above 256 KiB", async () => {
    const response = await call("/auth/passkeys/login/verify", { method: "POST", headers: json,
      body: JSON.stringify({ challengeId: "c".repeat(24), response: "x".repeat(300 * 1024) }) });
    expect(response.status).toBe(413);
  });

  it("logs out without a session and clears the cookie", async () => {
    const response = await call("/auth/logout", { method: "POST", headers: { Cookie: "__Host-lmail-session=%E0%A4%A" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("unexpected failures", () => {
  it("are answered as JSON without internal detail, on /auth and on /v1", async () => {
    const down = async () => { throw new Error("D1 is down: secret-table-name"); };
    const statement = { bind: () => statement, first: down, all: down, run: down };
    const broken = { ...workerEnv, DB: { prepare: () => statement, batch: down } } as unknown as Env;
    const fetch = (path: string) => worker.fetch(new Request(`https://mail.test${path}`,
      { headers: { Cookie: `__Host-lmail-session=${"s".repeat(40)}` } }), broken,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
    for (const path of ["/auth/status", "/v1/whoami"]) {
      const response = await fetch(path);
      expect(response.status, path).toBe(500);
      const text = await response.text();
      expect(text, path).not.toContain("secret-table-name");
      expect(JSON.parse(text), path).toMatchObject({ error: "Internal server error" });
    }
  });
});

describe("cookie parsing", () => {
  it("returns null for a missing or undecodable cookie", () => {
    expect(cookieValue(undefined, "a")).toBeNull();
    expect(cookieValue("b=1", "a")).toBeNull();
    expect(cookieValue("a=%E0%A4%A; b=1", "a")).toBeNull();
    expect(cookieValue("a=x%3Dy; b=1", "a")).toBe("x=y");
  });
});

describe("send preconditions", () => {
  const body = (extra: Record<string, unknown>) => JSON.stringify({ idempotencyKey: crypto.randomUUID(), from: OWNER,
    to: ["a@example.com"], subject: "s", text: "t", ...extra });

  it("refuses replies to mail outside the key's mailboxes or from another identity, before anything is sent", async () => {
    await env.DB.batch([OWNER, EXTERNAL].map((identity, index) => env.DB.prepare(`INSERT INTO messages
      (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
      VALUES (?, ?, 'inbound', 'inbox', 'sender@example.com', '[]', ?, '2026-08-11T12:00:00.000Z', 10, 'ready', ?)`)
      .bind(`m${index}`, `m${index}`, `raw/m${index}.eml`, identity)));
    const restricted = await issueApiKey(workerEnv, "owner", ["mail:send"], [OWNER], null, "test");
    const both = await issueApiKey(workerEnv, "both", ["mail:send"], [OWNER, EXTERNAL], null, "test");
    const post = (token: string, extra: Record<string, unknown>) => call("/v1/messages/send", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body(extra) });

    const hidden = await post(restricted.token, { replyToMessageId: "m1" });
    expect(hidden.status).toBe(404);
    const missing = await post(restricted.token, { replyToMessageId: "does-not-exist" });
    expect(missing.status).toBe(404);
    const wrongIdentity = await post(both.token, { replyToMessageId: "m1" });
    expect(wrongIdentity.status).toBe(409);
    expect(await wrongIdentity.json()).toMatchObject({ code: "conflict", retryable: false });
    const requests = await env.DB.prepare("SELECT COUNT(*) AS count FROM send_requests").first<{ count: number }>();
    expect(requests?.count).toBe(0);
  });

  it("refuses to send from an identity that is not enabled", async () => {
    const admin = await issueApiKey(workerEnv, "admin", ["mail:send"], null, null, "test");
    const response = await call("/v1/messages/send", { method: "POST",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" }, body: body({ from: "ghost@example.com" }) });
    expect(response.status).toBe(403);
    const status = await call("/v1/send-requests/11111111-1111-4111-8111-111111111111", { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(status.status).toBe(404);
  });
});

describe("spam helpers", () => {
  it("trusts the owner's identities and contacts, and nobody else", async () => {
    await env.DB.prepare("INSERT INTO contacts (identity_address, address, display_name, source) VALUES (?, 'contact@example.org', '', 'manual')")
      .bind(OWNER).run();
    expect(await isTrustedSender(workerEnv, OWNER)).toBe(true);
    expect(await isTrustedSender(workerEnv, "contact@example.org")).toBe(true);
    expect(await isTrustedSender(workerEnv, "stranger@example.com")).toBe(false);
  });

  it("reads both Workers AI response shapes and tolerates anything else", () => {
    expect(readModelText({ response: "old" })).toBe("old");
    expect(readModelText({ choices: [{ message: { content: "new" } }] })).toBe("new");
    expect(readModelText({ choices: [] })).toBe("");
    expect(readModelText(null)).toBe("");
    expect(readModelText("text")).toBe("");
  });
});
