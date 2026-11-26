import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueApiKey } from "../src/worker/auth";
import type { Env } from "../src/worker/types";

const workerEnv = env as Env;
const OWNER = "owner@example.com";
const EXTERNAL = "external@ext.example.org";
const ALL_MAIL = ["account:read", "mail:read", "mail:write", "mail:send", "addresses:read"];

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM autopilot_actions"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM drafts"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
});

async function key(scopes: string[], identities: string[] | null): Promise<Record<string, string>> {
  const issued = await issueApiKey(workerEnv, "hardening", scopes, identities, null, "test");
  return { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" };
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return workerExports.default.fetch(new Request(`https://mail.test${path}`, init));
}

function message(id: string, identity: string, status: "ready" | "pending" = "ready"): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO messages
    (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
    VALUES (?, ?, 'inbound', 'inbox', 'sender@example.com', ?, ?, '2026-08-11T12:00:00.000Z', 10, ?, ?)`)
    .bind(id, id, JSON.stringify([{ address: identity }]), `raw/${id}.eml`, status, identity);
}

describe("authentication", () => {
  it("answers 401 without credentials, with a malformed token, and with a malformed session cookie", async () => {
    expect((await call("/v1/whoami")).status).toBe(401);
    expect((await call("/v1/whoami", { headers: { Authorization: "Bearer not-a-token" } })).status).toBe(401);
    expect((await call("/v1/whoami", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    const cookie = await call("/v1/whoami", { headers: { Cookie: "__Host-lmail-session=%E0%A4%A" } });
    expect(cookie.status).toBe(401);
    expect(await cookie.json()).toMatchObject({ code: "unauthorized" });
  });

  it("requires authentication before it reveals whether a /v1 route exists", async () => {
    expect((await call("/v1/does-not-exist")).status).toBe(401);
    expect((await call("/does-not-exist")).status).toBe(404);
    const health = await call("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it("rejects an expired key", async () => {
    const issued = await issueApiKey(workerEnv, "expired", ["account:read"], [OWNER], "2020-01-01T00:00:00.000Z", "test");
    expect((await call("/v1/whoami", { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(401);
  });

  it("enforces scopes per route", async () => {
    const readOnly = await key(["mail:read"], [OWNER]);
    expect((await call("/v1/messages", { headers: readOnly })).status).toBe(200);
    expect((await call("/v1/whoami", { headers: readOnly })).status).toBe(403);
    expect((await call("/v1/addresses", { headers: readOnly })).status).toBe(403);
    expect((await call("/v1/keys", { headers: readOnly })).status).toBe(403);
    expect((await call("/v1/audit", { headers: readOnly })).status).toBe(403);
    expect((await call("/v1/drafts", { method: "PUT", headers: readOnly, body: JSON.stringify({ from: OWNER }) })).status).toBe(403);
    expect((await call("/v1/messages/send", { method: "POST", headers: readOnly, body: "{}" })).status).toBe(403);
  });
});

describe("input validation", () => {
  it("answers 400 for bodies that are not JSON or do not match the schema", async () => {
    const headers = await key(ALL_MAIL, [OWNER]);
    for (const [method, path] of [["POST", "/v1/messages/send"], ["PUT", "/v1/drafts"], ["POST", "/v1/contacts"],
      ["PATCH", "/v1/messages/some-id"], ["PUT", "/v1/push-devices"], ["POST", "/v1/agent"]] as const) {
      const notJson = await call(path, { method, headers, body: "{not json" });
      expect(notJson.status, `${method} ${path} not JSON`).toBe(400);
      expect(await notJson.json()).toMatchObject({ code: "invalid_request", retryable: false, requestId: expect.any(String) });
      expect((await call(path, { method, headers, body: JSON.stringify({ unexpected: [1, 2, 3] }) })).status,
        `${method} ${path} wrong shape`).toBe(400);
    }
  });

  it("answers 400 for invalid query parameters", async () => {
    const headers = await key(ALL_MAIL, [OWNER]);
    for (const path of ["/v1/messages?folder=nowhere", "/v1/messages?identity=not-an-address", "/v1/summary?identity=x",
      `/v1/messages?query=${"a".repeat(51)}`, "/v1/mailbox-state?after=abc", "/v1/mailbox-state?wait=26",
      "/v1/mailbox-delta?since=0", `/v1/mailbox-delta?identity=${encodeURIComponent(OWNER)}&since=x`,
      `/v1/mailbox-delta?identity=${encodeURIComponent(OWNER)}&since=0&cursor=garbage`,
      "/v1/mailbox-snapshot?includeAddresses=maybe", "/v1/deliverability?hours=0", "/v1/send-requests/not-a-uuid",
      "/v1/autopilot/actions?before=%27%20OR%201", `/v1/contacts?query=${"a".repeat(101)}`]) {
      expect((await call(path, { headers })).status, path).toBe(400);
    }
  });

  it("refuses a request body above 7 MiB", async () => {
    const headers = await key(ALL_MAIL, [OWNER]);
    const response = await call("/v1/drafts", { method: "PUT", headers, body: JSON.stringify({ from: OWNER, text: "x".repeat(7 * 1024 * 1024) }) });
    expect(response.status).toBe(413);
  });

  it("rejects send requests with bad recipients, attachments or idempotency keys", async () => {
    const headers = await key(ALL_MAIL, [OWNER]);
    const valid = { idempotencyKey: "11111111-1111-4111-8111-111111111111", from: OWNER, to: ["a@example.com"], subject: "s", text: "t" };
    for (const body of [{ ...valid, idempotencyKey: "nope" }, { ...valid, to: [] }, { ...valid, to: ["not an address"] },
      { ...valid, to: Array.from({ length: 21 }, (_, index) => `r${index}@example.com`) },
      { ...valid, attachments: [{ filename: "a.txt", contentType: "text/plain", data: "not base64!" }] },
      { ...valid, subject: "x".repeat(999) }]) {
      expect((await call("/v1/messages/send", { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    const foreign = await call("/v1/messages/send", { method: "POST", headers, body: JSON.stringify({ ...valid, from: EXTERNAL }) });
    expect(foreign.status).toBe(403);
  });
});

describe("identity isolation", () => {
  it("hides another mailbox's messages, raw mail and attachments behind 404", async () => {
    await env.DB.batch([message("mine", OWNER), message("theirs", EXTERNAL)]);
    const headers = await key(ALL_MAIL, [OWNER]);
    expect((await call("/v1/messages/mine", { headers })).status).toBe(200);
    expect((await call("/v1/messages/theirs", { headers })).status).toBe(404);
    expect((await call("/v1/messages/theirs/raw", { headers })).status).toBe(404);
    expect((await call("/v1/messages/theirs/sender-logo", { headers })).status).toBe(404);
    expect((await call("/v1/attachments/none", { headers })).status).toBe(404);
    expect((await call("/v1/messages/theirs", { method: "PATCH", headers, body: JSON.stringify({ unread: false }) })).status).toBe(404);
    const list = await call(`/v1/messages?identity=${encodeURIComponent(EXTERNAL)}`, { headers });
    expect(await list.json()).toMatchObject({ messages: [] });
    const row = await env.DB.prepare("SELECT unread FROM messages WHERE id = 'theirs'").first<{ unread: number }>();
    expect(row?.unread).toBe(1);
  });

  it("changes only messages that are visible", async () => {
    await env.DB.batch([message("ready", OWNER), message("pending", OWNER, "pending")]);
    const headers = await key(ALL_MAIL, [OWNER]);
    const body = JSON.stringify({ folder: "archive" });
    expect((await call("/v1/messages/ready", { method: "PATCH", headers, body })).status).toBe(200);
    expect((await call("/v1/messages/pending", { method: "PATCH", headers, body })).status).toBe(404);
    expect((await call("/v1/messages/ready", { method: "PATCH", headers, body: JSON.stringify({ folder: "drafts" }) })).status).toBe(400);
    expect((await call("/v1/messages/ready", { method: "PATCH", headers, body: "{}" })).status).toBe(400);
    const rows = await env.DB.prepare("SELECT id, folder FROM messages ORDER BY id").all<{ id: string; folder: string }>();
    expect(rows.results).toEqual([{ id: "pending", folder: "inbox" }, { id: "ready", folder: "archive" }]);
  });

  it("does not let a key overwrite a draft of a mailbox it cannot access", async () => {
    await env.DB.prepare(`INSERT INTO drafts (id, identity_address, recipients_json, cc_json, bcc_json, subject, text_body)
      VALUES ('school-draft', ?, '[]', '[]', '[]', 'Hausaufgabe', 'private')`).bind(EXTERNAL).run();
    const headers = await key(ALL_MAIL, [OWNER]);
    const hijack = await call("/v1/drafts", { method: "PUT", headers, body: JSON.stringify({ id: "school-draft", from: OWNER, text: "overwritten" }) });
    expect(hijack.status).toBe(404);
    const kept = await env.DB.prepare("SELECT identity_address, text_body FROM drafts WHERE id = 'school-draft'")
      .first<{ identity_address: string; text_body: string }>();
    expect(kept).toEqual({ identity_address: EXTERNAL, text_body: "private" });
    expect((await call("/v1/drafts/school-draft", { method: "DELETE", headers })).status).toBe(404);
    expect((await call("/v1/drafts", { method: "PUT", headers, body: JSON.stringify({ from: EXTERNAL }) })).status).toBe(403);
    expect((await call("/v1/drafts", { method: "PUT", headers, body: JSON.stringify({ id: "bad id\n", from: OWNER }) })).status).toBe(400);

    const own = await call("/v1/drafts", { method: "PUT", headers, body: JSON.stringify({ id: "MY-DRAFT-1", from: OWNER, text: "one" }) });
    expect(own.status).toBe(200);
    const again = await call("/v1/drafts", { method: "PUT", headers, body: JSON.stringify({ id: "MY-DRAFT-1", from: OWNER, text: "two" }) });
    expect(again.status).toBe(200);
    const listed = await call("/v1/drafts", { headers });
    expect(await listed.json()).toMatchObject({ drafts: [{ id: "MY-DRAFT-1", from: OWNER, text: "two" }] });
  });

  it("lists external accounts only to keys that can read their mailbox", async () => {
    const restricted = await call("/v1/external/status", { headers: await key(ALL_MAIL, [OWNER]) });
    expect(await restricted.json()).toEqual({ accounts: [] });
    const school = await call("/v1/external/status", { headers: await key(ALL_MAIL, [EXTERNAL]) });
    expect(await school.json()).toMatchObject({ accounts: [{ identity: EXTERNAL }] });
    const sync = await call("/v1/external/sync", { method: "POST", headers: await key(ALL_MAIL, [OWNER]), body: JSON.stringify({ identity: EXTERNAL }) });
    expect(sync.status).toBe(403);
  });

  it("keeps owner-only surfaces away from keys without the owner's mailbox", async () => {
    // The test owner is owner@example.com, so a key for external@ is not the owner's.
    const headers = await key(ALL_MAIL, [EXTERNAL]);
    for (const [method, path, body] of [["GET", "/v1/agent/chats", undefined], ["GET", "/v1/agent/chats/x", undefined],
      ["DELETE", "/v1/agent/chats/x", undefined], ["PATCH", "/v1/autopilot", { enabled: false }],
      ["POST", "/v1/autopilot/rules", { category: "newsletter", action: "archive" }], ["DELETE", "/v1/autopilot/rules/x", undefined],
      ["POST", "/v1/autopilot/brief", undefined], ["POST", "/v1/autopilot/sweep", undefined]] as const) {
      const response = await call(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("undoes an autopilot action only by a well-formed id inside the key's mailboxes", async () => {
    await env.DB.batch([message("filed", EXTERNAL),
      env.DB.prepare(`INSERT INTO autopilot_actions (id, message_id, action, previous_folder, previous_unread, previous_starred, previous_spam)
        VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'filed', 'archive', 'inbox', 1, 0, 0)`)]);
    const headers = await key(ALL_MAIL, [OWNER]);
    expect((await call("/v1/autopilot/actions/%25%25%25%25%25%25%25%25/undo", { method: "POST", headers })).status).toBe(400);
    expect((await call("/v1/autopilot/actions/short/undo", { method: "POST", headers })).status).toBe(400);
    expect((await call("/v1/autopilot/actions/aaaaaaaa/undo", { method: "POST", headers })).status).toBe(404);
    const listed = await call("/v1/autopilot/actions", { headers });
    expect(await listed.json()).toMatchObject({ actions: [] });
    const undone = await env.DB.prepare("SELECT undone_at FROM autopilot_actions").first<{ undone_at: string | null }>();
    expect(undone?.undone_at).toBeNull();
  });
});

describe("administration", () => {
  const ADMIN = ["account:read", "mail:read", "addresses:read", "addresses:write", "keys:read", "keys:write", "audit:read"];
  const confirmed = { "X-Admin-Confirmation": "user-approved" };

  it("requires the explicit confirmation header for administrative mutations", async () => {
    const headers = await key(ADMIN, null);
    for (const [method, path] of [["POST", "/v1/keys"], ["POST", "/v1/keys/device"], ["DELETE", "/v1/keys/abc"],
      ["POST", "/v1/addresses"], ["PATCH", "/v1/addresses/a%40example.com"], ["DELETE", "/v1/addresses/a%40example.com"]] as const) {
      expect((await call(path, { method, headers, body: "{}" })).status, `${method} ${path}`).toBe(428);
    }
  });

  it("never lets a key grant more than it holds", async () => {
    const restricted = { ...await key(["keys:write", "mail:read"], [OWNER]), ...confirmed };
    const post = (body: unknown) => call("/v1/keys", { method: "POST", headers: restricted, body: JSON.stringify(body) });
    expect((await post({ name: "k", scopes: ["mail:send"], identities: [OWNER] })).status).toBe(403);
    expect((await post({ name: "k", scopes: ["mail:read"], identities: [EXTERNAL] })).status).toBe(403);
    expect((await post({ name: "k", scopes: ["keys:write"], identities: null })).status).toBe(403);
    expect((await post({ name: "k", scopes: ["mail:read"], identities: [] })).status).toBe(400);
    expect((await post({ name: "k", scopes: ["everything"], identities: [OWNER] })).status).toBe(400);
    expect((await post({ name: "k", scopes: ["mail:read"], identities: [OWNER], expiresAt: "2020-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await post({ name: "k", scopes: ["mail:read"], identities: ["nobody@example.com"] })).status).toBe(403);
    const created = await post({ name: "child", scopes: ["mail:read"], identities: [OWNER] });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: "child", scopes: ["mail:read"], identities: [OWNER], token: expect.stringMatching(/^lm_live_/) });
    // Address administration is for unrestricted administrator keys only.
    const addressAdmin = { ...await key(["addresses:write"], [OWNER]), ...confirmed };
    expect((await call("/v1/addresses", { method: "POST", headers: addressAdmin, body: JSON.stringify({ address: "new@example.com" }) })).status).toBe(403);
    expect((await call(`/v1/addresses/${encodeURIComponent(OWNER)}`, { method: "DELETE", headers: addressAdmin })).status).toBe(403);
  });

  it("revokes other keys but not the calling one, and never returns secret hashes", async () => {
    const admin = await issueApiKey(workerEnv, "admin", ADMIN, null, null, "test");
    const other = await issueApiKey(workerEnv, "other", ["mail:read"], [OWNER], null, "test");
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json", ...confirmed };
    expect((await call(`/v1/keys/${admin.id}`, { method: "DELETE", headers })).status).toBe(409);
    expect((await call(`/v1/keys/${other.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await call(`/v1/keys/${other.id}`, { method: "DELETE", headers })).status).toBe(404);
    expect((await call("/v1/messages", { headers: { Authorization: `Bearer ${other.token}` } })).status).toBe(401);
    const listed = await call("/v1/keys", { headers });
    const text = await listed.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toMatchObject({ keys: expect.arrayContaining([expect.objectContaining({ id: other.id, scopes: ["mail:read"], identities: [OWNER] })]) });
  });

  it("lets a restricted key revoke only keys that reach no further than itself", async () => {
    const admin = await issueApiKey(workerEnv, "admin", ADMIN, null, null, "test");
    const wider = await issueApiKey(workerEnv, "wider", ["mail:read"], [OWNER, EXTERNAL], null, "test");
    const narrow = await issueApiKey(workerEnv, "narrow", ["mail:read"], [OWNER], null, "test");
    const headers = { ...await key(["keys:write"], [OWNER]), ...confirmed };
    expect((await call(`/v1/keys/${admin.id}`, { method: "DELETE", headers })).status).toBe(403);
    expect((await call(`/v1/keys/${wider.id}`, { method: "DELETE", headers })).status).toBe(403);
    expect((await call("/v1/keys/unknown", { method: "DELETE", headers })).status).toBe(404);
    expect((await call(`/v1/keys/${narrow.id}`, { method: "DELETE", headers })).status).toBe(200);
    const active = await env.DB.prepare("SELECT id FROM api_keys WHERE revoked_at IS NULL AND id IN (?, ?, ?) ORDER BY id")
      .bind(admin.id, wider.id, narrow.id).all<{ id: string }>();
    expect(active.results.map((row) => row.id).sort()).toEqual([admin.id, wider.id].sort());
  });

  it("filters the audit log literally and survives a damaged metadata row", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO audit_logs (id, request_id, key_id, actor, action, resource, status, ip_hash, metadata_json)
        VALUES ('1', 'r1', 'k1', 'a', 'GET /v1/a_b', '-', 200, 'h', '{"colo":"FRA"}')`),
      env.DB.prepare(`INSERT INTO audit_logs (id, request_id, key_id, actor, action, resource, status, ip_hash, metadata_json)
        VALUES ('2', 'r2', 'k2', 'a', 'GET /v1/axb', '-', 200, 'h', '{broken')`),
    ]);
    const headers = await key(ADMIN, null);
    const literal = await call("/v1/audit?action=a_b", { headers });
    expect(literal.status).toBe(200);
    expect(await literal.json()).toMatchObject({ events: [{ id: "1", metadata: { colo: "FRA" } }] });
    const damaged = await call("/v1/audit?keyId=k2", { headers });
    expect(damaged.status).toBe(200);
    expect(await damaged.json()).toMatchObject({ events: [{ id: "2", metadata: null }] });
    expect((await call(`/v1/audit?action=${"a".repeat(51)}`, { headers })).status).toBe(400);
    expect((await call(`/v1/audit?keyId=${"k".repeat(65)}`, { headers })).status).toBe(400);
  });
});
