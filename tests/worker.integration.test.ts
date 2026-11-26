import { env, exports as workerExports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueDeviceApiKey } from "../src/worker/auth";
import { sha256 } from "../src/worker/crypto";
import { processInbound } from "../src/worker/inbound";
import { runMaintenance } from "../src/worker/maintenance";
import { deliverOutbound } from "../src/worker/outbound";
import { deliverPushJob } from "../src/worker/push";
import type { Env, InboundJob } from "../src/worker/types";

const workerEnv = env as Env;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM drafts"),
    env.DB.prepare("DELETE FROM send_recipients"),
    env.DB.prepare("DELETE FROM send_requests"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(`INSERT INTO api_keys
    (id, name, secret_hash, scopes_json, allowed_identities_json)
    VALUES ('integration-key', 'integration', 'hash', '["mail:send"]', '["owner@example.com"]')`).run();
});

afterEach(() => vi.unstubAllGlobals());

describe("inbound processing", () => {
  it("commits attachment metadata and ready visibility together", async () => {
    const job = await stageInbound("atomic-inbound", mimeWithAttachments(2));
    await processInbound(job, workerEnv);

    const message = await env.DB.prepare(`SELECT status, attachment_count, stored_attachment_count
      FROM messages WHERE id = ?`).bind(job.id).first<{
        status: string; attachment_count: number; stored_attachment_count: number;
      }>();
    const attachments = await env.DB.prepare("SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?")
      .bind(job.id).first<{ count: number }>();
    expect(message).toEqual({ status: "ready", attachment_count: 2, stored_attachment_count: 2 });
    expect(attachments?.count).toBe(2);
  });

  it("keeps the message pending when an attachment object write fails", async () => {
    const job = await stageInbound("failed-attachment", mimeWithAttachments(1));
    const failingBucket = new Proxy(env.MAIL, {
      get(target, property) {
        if (property === "put") return async (key: string,
          value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions) => {
          if (key.startsWith("attachment/")) throw new Error("injected R2 attachment failure");
          return target.put(key, value, options);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const failingEnv = { DB: env.DB, MAIL: failingBucket } as Env;

    await expect(processInbound(job, failingEnv)).rejects.toThrow("injected R2 attachment failure");
    const message = await env.DB.prepare("SELECT status FROM messages WHERE id = ?").bind(job.id).first<{ status: string }>();
    const attachments = await env.DB.prepare("SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?")
      .bind(job.id).first<{ count: number }>();
    expect(message?.status).toBe("pending");
    expect(attachments?.count).toBe(0);
  });

  it("reports extracted attachment truncation without hiding the raw message", async () => {
    const job = await stageInbound("truncated-attachments", mimeWithAttachments(51));
    await processInbound(job, workerEnv);
    const message = await env.DB.prepare(`SELECT status, attachment_count, stored_attachment_count, raw_key
      FROM messages WHERE id = ?`).bind(job.id).first<{
        status: string; attachment_count: number; stored_attachment_count: number; raw_key: string;
      }>();
    expect(message?.status).toBe("ready");
    expect(message?.attachment_count).toBe(51);
    expect(message?.stored_attachment_count).toBe(50);
    expect(await env.MAIL.head(message!.raw_key)).not.toBeNull();
  });
});

describe("durable outbound sending", () => {
  it("deduplicates recipients and replays a completed idempotent response", async () => {
    const delivered: string[] = [];
    const outboundEnv = withEmail(async (message) => {
      delivered.push(message.to);
      return { messageId: `provider-${message.to}` };
    });
    const input = outboundInput({ to: ["a@example.com", "a@example.com"], cc: ["a@example.com", "b@example.com"],
      bcc: ["c@example.com"] });

    const first = await deliverOutbound(outboundEnv, input);
    const replay = await deliverOutbound(outboundEnv, input);
    const mismatch = await deliverOutbound(outboundEnv, { ...input, requestHash: "different" });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(mismatch.statusCode).toBe(409);
    expect(delivered).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    const recipients = await env.DB.prepare("SELECT COUNT(*) AS count FROM send_recipients").first<{ count: number }>();
    const message = await env.DB.prepare("SELECT status FROM messages").first<{ status: string }>();
    expect(recipients?.count).toBe(3);
    expect(message?.status).toBe("ready");
    const contacts = await env.DB.prepare(`SELECT address, send_count FROM contacts
      WHERE identity_address = 'owner@example.com' ORDER BY address`).all<{ address: string; send_count: number }>();
    expect(contacts.results).toEqual([
      { address: "a@example.com", send_count: 1 },
      { address: "b@example.com", send_count: 1 },
      { address: "c@example.com", send_count: 1 },
    ]);
  });

  it("persists recipient-level partial and unknown outcomes", async () => {
    const outboundEnv = withEmail(async (message) => {
      if (message.to === "unknown@example.com") throw new Error("connection closed after upload");
      return { messageId: `provider-${message.to}` };
    });
    const result = await deliverOutbound(outboundEnv, outboundInput({
      to: ["sent@example.com", "unknown@example.com"], cc: [], bcc: [],
    }));

    expect(result.statusCode).toBe(502);
    expect(result.response).toMatchObject({ status: "partial", sent: false });
    const request = await env.DB.prepare("SELECT status FROM send_requests").first<{ status: string }>();
    const recipients = await env.DB.prepare("SELECT recipient, status FROM send_recipients ORDER BY recipient")
      .all<{ recipient: string; status: string }>();
    expect(request?.status).toBe("partial");
    expect(recipients.results).toEqual([
      { recipient: "sent@example.com", status: "sent" },
      { recipient: "unknown@example.com", status: "unknown" },
    ]);
    const contacts = await env.DB.prepare("SELECT address FROM contacts ORDER BY address").all<{ address: string }>();
    expect(contacts.results).toEqual([{ address: "sent@example.com" }]);
  });
});

describe("credentials and maintenance", () => {
  it("peppers newly issued device credentials with a versioned digest", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "test-device", ["mail:read"], ["owner@example.com"],
      "2027-08-11T00:00:00.000Z", "integration-key");
    const secret = issued.token.slice(`lm_device_${issued.id}_`.length);
    const row = await env.DB.prepare("SELECT secret_hash FROM api_keys WHERE id = ?")
      .bind(issued.id).first<{ secret_hash: string }>();
    expect(row?.secret_hash).toBe(`device-v2:${await sha256(`test-api-pepper:device:${secret}`)}`);
  });

  it("re-enqueues stale pending inbound messages when their raw object exists", async () => {
    const job = await stageInbound("stale-inbound", mimeWithAttachments(0));
    await env.DB.prepare("UPDATE messages SET updated_at = datetime('now', '-20 minutes') WHERE id = ?").bind(job.id).run();
    const result = await runMaintenance(workerEnv, false);
    const row = await env.DB.prepare("SELECT status, updated_at FROM messages WHERE id = ?")
      .bind(job.id).first<{ status: string; updated_at: string }>();
    expect(result.recoveredInbound).toBe(1);
    expect(row?.status).toBe("pending");
    expect(new Date(`${row!.updated_at}Z`).valueOf()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("authenticated Worker API", () => {
  it("accepts an active key and rejects it immediately after revocation", async () => {
    const id = "abcdefghijklmnop";
    const secret = "A".repeat(86);
    const token = `lm_live_${id}_${secret}`;
    await env.DB.prepare(`INSERT INTO api_keys
      (id, name, secret_hash, scopes_json, allowed_identities_json)
      VALUES (?, 'api-integration', ?, '["account:read"]', '["owner@example.com"]')`)
      .bind(id, await sha256(`test-api-pepper:${secret}`)).run();

    const active = await workerExports.default.fetch(new Request("https://mail.test/v1/whoami", {
      headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "192.0.2.10" },
    }));
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ principal: { keyId: id, name: "api-integration" } });

    await env.DB.prepare("UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    const revoked = await workerExports.default.fetch(new Request("https://mail.test/v1/whoami", {
      headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "192.0.2.10" },
    }));
    expect(revoked.status).toBe(401);
  });

  it("filters each inbox identity and normalizes legacy sent recipients", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "multi-inbox", ["mail:read"],
      ["owner@example.com", "billing@aws.example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    await env.DB.batch([
      readyMessage("owner-sent", "owner@example.com", "sent", '["recipient@example.com"]'),
      readyMessage("billing-inbox", "billing@aws.example.com", "inbox", '[{"address":"billing@aws.example.com"}]'),
    ]);

    const ownerResp = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/messages?folder=sent&identity=owner%40example.com",
      { headers: { Authorization: `Bearer ${issued.token}` } },
    ));
    const billing = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/messages?folder=inbox&identity=billing%40aws.example.com",
      { headers: { Authorization: `Bearer ${issued.token}` } },
    ));

    expect(ownerResp.status).toBe(200);
    expect(await ownerResp.json()).toMatchObject({ messages: [{ id: "owner-sent",
      sender: { avatarColor: expect.stringMatching(/^#[0-9A-F]{6}$/) },
      recipients: [{ address: "recipient@example.com", avatarColor: expect.stringMatching(/^#[0-9A-F]{6}$/) }] }] });
    expect(billing.status).toBe(200);
    expect(await billing.json()).toMatchObject({ messages: [{ id: "billing-inbox" }] });
  });

  it("exposes a monotonic mailbox revision scoped to the requested identity", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "mailbox-state", ["mail:read"],
      ["owner@example.com", "billing@aws.example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    const url = "https://mail.test/v1/mailbox-state?identity=owner%40example.com&wait=0";
    const headers = { Authorization: `Bearer ${issued.token}` };
    const beforeResponse = await workerExports.default.fetch(new Request(url, { headers }));
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json<{ revision: string; changed: boolean }>();
    expect(before.changed).toBe(false);

    await readyMessage("new-revision", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]').run();
    const afterResponse = await workerExports.default.fetch(new Request(`${url}&after=${before.revision}`, { headers }));
    const after = await afterResponse.json<{ revision: string; changed: boolean }>();
    expect(after.changed).toBe(true);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));

    await readyMessage("other-revision", "billing@aws.example.com", "inbox",
      '[{"address":"billing@aws.example.com"}]').run();
    const unchangedResponse = await workerExports.default.fetch(new Request(`${url}&after=${after.revision}`, { headers }));
    await expect(unchangedResponse.json()).resolves.toMatchObject({ revision: after.revision, changed: false });
  });

  it("streams contiguous identity-scoped mailbox deltas across bounded pages", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "mailbox-delta", ["mail:read"],
      ["owner@example.com", "billing@aws.example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    const headers = { Authorization: `Bearer ${issued.token}` };
    const stateUrl = "https://mail.test/v1/mailbox-state?identity=owner%40example.com&wait=0";
    const before = await (await workerExports.default.fetch(new Request(stateUrl, { headers })))
      .json<{ revision: string }>();

    await readyMessage("delta-move", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]').run();
    await readyMessage("delta-delete", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]').run();
    await env.DB.prepare("UPDATE messages SET folder = 'archive', starred = 1 WHERE id = 'delta-move'").run();
    await env.DB.prepare("DELETE FROM messages WHERE id = 'delta-delete'").run();
    await env.DB.prepare(`INSERT INTO drafts (id, identity_address, recipients_json, cc_json, bcc_json, subject)
      VALUES ('delta-draft', 'owner@example.com', '[]', '[]', '[]', 'Incremental')`).run();
    await readyMessage("delta-other-identity", "billing@aws.example.com", "inbox",
      '[{"address":"billing@aws.example.com"}]').run();

    const firstResponse = await workerExports.default.fetch(new Request(
      `https://mail.test/v1/mailbox-delta?identity=owner%40example.com&since=${before.revision}&limit=2`, { headers },
    ));
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("ETag")).toMatch(/^"/);
    const first = await firstResponse.json<{
      identity: string; revision: string; changes: Array<{ revision: string; kind: string; id: string; operation: string;
        previousFolder: string | null; message?: { folder: string; starred: boolean } }>;
      hasMore: boolean; nextCursor: string; resetRequired: boolean;
    }>();
    expect(first).toMatchObject({ identity: "owner@example.com", hasMore: true, resetRequired: false });
    expect(first.changes).toHaveLength(2);
    expect(BigInt(first.changes[1].revision)).toBe(BigInt(first.changes[0].revision) + 1n);

    const allChanges = [...first.changes];
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page: { changes: Array<{ revision: string; kind: string; id: string; operation: string;
        previousFolder: string | null; message?: { folder: string; starred: boolean } }>;
        hasMore: boolean; nextCursor: string | null; revision: string } = await (await workerExports.default.fetch(new Request(
        `https://mail.test/v1/mailbox-delta?identity=owner%40example.com&since=${before.revision}&limit=2&cursor=${encodeURIComponent(cursor)}`,
        { headers },
      ))).json();
      allChanges.push(...page.changes);
      cursor = page.hasMore ? page.nextCursor : null;
      expect(page.revision).toBe(first.revision);
    }
    expect(allChanges.map((change) => change.id)).toEqual([
      "delta-move", "delta-delete", "delta-move", "delta-delete", "delta-draft",
    ]);
    expect(allChanges.at(-3)).toMatchObject({ id: "delta-move", operation: "upsert", previousFolder: "inbox",
      message: { folder: "archive", starred: true } });
    expect(allChanges.at(-2)).toMatchObject({ id: "delta-delete", operation: "delete" });
    expect(allChanges.at(-1)).toMatchObject({ id: "delta-draft", kind: "draft", operation: "upsert" });
    for (let index = 1; index < allChanges.length; index += 1) {
      expect(BigInt(allChanges[index]!.revision)).toBe(BigInt(allChanges[index - 1]!.revision) + 1n);
    }
  });

  it("requires an exact delta identity and requests a reset for missing history", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "mailbox-delta-reset", ["mail:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    const headers = { Authorization: `Bearer ${issued.token}` };
    const missingIdentity = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/mailbox-delta?since=0", { headers },
    ));
    expect(missingIdentity.status).toBe(400);

    const state = await (await workerExports.default.fetch(new Request(
      "https://mail.test/v1/mailbox-state?identity=owner%40example.com&wait=0", { headers },
    ))).json<{ revision: string }>();
    await readyMessage("delta-gap", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]').run();
    await env.DB.prepare("DELETE FROM mailbox_changes WHERE identity_address = ? AND revision > ?")
      .bind("owner@example.com", state.revision).run();
    const reset = await (await workerExports.default.fetch(new Request(
      `https://mail.test/v1/mailbox-delta?identity=owner%40example.com&since=${state.revision}`, { headers },
    ))).json<{ resetRequired: boolean; reason: string; changes: unknown[] }>();
    expect(reset).toMatchObject({ resetRequired: true, reason: "non_contiguous", changes: [] });
  });

  it("registers push tokens only for enabled identities in the authenticated session", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "push-device", ["mail:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    const headers = { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" };
    const token = "ab".repeat(32);
    const registered = await workerExports.default.fetch(new Request("https://mail.test/v1/push-devices", {
      method: "PUT", headers, body: JSON.stringify({ deviceToken: token, environment: "development",
        identities: ["owner@example.com"] }),
    }));
    expect(registered.status).toBe(200);
    await expect(registered.json()).resolves.toEqual({ registered: true, identities: ["owner@example.com"] });
    const row = await env.DB.prepare(`SELECT key_id, device_token, environment, identities_json, disabled_at
      FROM push_devices WHERE device_token = ?`).bind(token).first();
    expect(row).toEqual({ key_id: issued.id, device_token: token, environment: "development",
      identities_json: '["owner@example.com"]', disabled_at: null });

    const forbidden = await workerExports.default.fetch(new Request("https://mail.test/v1/push-devices", {
      method: "PUT", headers, body: JSON.stringify({ deviceToken: "cd".repeat(32), environment: "development",
        identities: ["billing@aws.example.com"] }),
    }));
    expect(forbidden.status).toBe(403);
  });

  it("creates a durable notification outbox entry exactly when inbound mail becomes visible", async () => {
    await env.DB.prepare(`INSERT INTO messages
      (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
      VALUES ('push-outbox', 'push-thread', 'inbound', 'inbox', 'sender@example.com',
        '[{"address":"owner@example.com"}]', 'raw/push-outbox.eml', '2026-08-11T12:00:00.000Z', 10, 'pending',
        'owner@example.com')`).run();
    expect(await env.DB.prepare("SELECT message_id FROM push_notification_outbox WHERE message_id = 'push-outbox'").first()).toBeNull();

    await env.DB.prepare("UPDATE messages SET status = 'ready' WHERE id = 'push-outbox'").run();
    expect(await env.DB.prepare(`SELECT message_id, identity_address, status, attempts
      FROM push_notification_outbox WHERE message_id = 'push-outbox'`).first()).toEqual({
      message_id: "push-outbox", identity_address: "owner@example.com", status: "pending", attempts: 0,
    });
    await env.DB.prepare("UPDATE messages SET unread = 0 WHERE id = 'push-outbox'").run();
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM push_notification_outbox
      WHERE message_id = 'push-outbox'`).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("delivers a signed APNs alert and commits the durable outbox", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "push-delivery", ["mail:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    await env.DB.prepare(`INSERT INTO push_devices
      (id, key_id, device_token, environment, identities_json)
      VALUES ('push-device', ?, ?, 'development', '["owner@example.com"]')`)
      .bind(issued.id, "ab".repeat(32)).run();
    await readyMessage("push-delivery", "owner@example.com", "inbox",
      '[{"address":"owner@example.com"}]').run();
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 200 });
    }));

    await deliverPushJob(await pushTestEnv(), { kind: "push", messageId: "push-delivery" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("api.sandbox.push.apple.com/3/device/");
    expect(requests[0]!.headers.get("authorization")).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(requests[0]!.headers.get("apns-topic")).toBe("com.example.lmail");
    await expect(requests[0]!.json()).resolves.toMatchObject({
      aps: { alert: { title: "sender@example.com", body: "No Subject" }, sound: "default" },
      messageId: "push-delivery", identity: "owner@example.com",
    });
    expect(await env.DB.prepare(`SELECT message_id FROM push_notification_outbox
      WHERE message_id = 'push-delivery'`).first()).toBeNull();
    await expect(env.DB.prepare("SELECT failure_count FROM push_devices WHERE id = 'push-device'").first())
      .resolves.toEqual({ failure_count: 0 });
  });

  it("preserves the push outbox across retryable APNs failures", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "push-retry", ["mail:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    await env.DB.prepare(`INSERT INTO push_devices
      (id, key_id, device_token, environment, identities_json)
      VALUES ('retry-device', ?, ?, 'development', '["owner@example.com"]')`)
      .bind(issued.id, "cd".repeat(32)).run();
    await readyMessage("push-retry", "owner@example.com", "inbox",
      '[{"address":"owner@example.com"}]').run();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ reason: "ServiceUnavailable" }, { status: 503 })));

    await expect(deliverPushJob(await pushTestEnv(), { kind: "push", messageId: "push-retry" }))
      .rejects.toThrow("APNs 503 ServiceUnavailable");
    await expect(env.DB.prepare(`SELECT status, attempts FROM push_notification_outbox
      WHERE message_id = 'push-retry'`).first()).resolves.toEqual({ status: "pending", attempts: 1 });
  });

  it("returns an ETagged, D1-batched native mailbox snapshot", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "snapshot", ["mail:read", "addresses:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    await env.DB.batch([
      readyMessage("snapshot-z-new", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]'),
      readyMessage("snapshot-a-old", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]'),
      env.DB.prepare(`INSERT INTO drafts (id, identity_address, recipients_json, cc_json, bcc_json, subject, text_body)
        VALUES ('snapshot-draft', 'owner@example.com', '["friend@example.com"]', '[]', '[]', 'Draft subject', 'Draft body')`),
    ]);
    await env.DB.prepare("UPDATE messages SET starred = 1 WHERE id = 'snapshot-z-new'").run();
    const headers = { Authorization: `Bearer ${issued.token}` };
    const url = "https://mail.test/v1/mailbox-snapshot?identity=owner%40example.com&folder=inbox&limit=1&includeAddresses=1";

    const response = await workerExports.default.fetch(new Request(url, { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const snapshot = await response.json<{
      revision: string;
      summary: { unread: number; inbox: number; starred: number; drafts: number };
      messages: Array<{ id: string; attachmentCount?: number }>;
      nextCursor: string | null;
      drafts: unknown[];
      addresses: Array<{ address: string }>;
    }>();
    expect(snapshot.summary).toMatchObject({ unread: 2, inbox: 2, starred: 1, drafts: 1 });
    expect(snapshot.messages).toEqual([expect.objectContaining({ id: "snapshot-z-new", attachmentCount: 0 })]);
    expect(snapshot.nextCursor).not.toBeNull();
    expect(snapshot.drafts).toEqual([]);
    expect(snapshot.addresses).toEqual([expect.objectContaining({ address: "owner@example.com" })]);

    const notModified = await workerExports.default.fetch(new Request(url, { headers: {
      ...headers, "If-None-Match": response.headers.get("ETag")!,
    } }));
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    const drafts = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/mailbox-snapshot?identity=owner%40example.com&folder=drafts", { headers },
    ));
    expect(await drafts.json()).toMatchObject({ messages: [], nextCursor: null,
      drafts: [{ id: "snapshot-draft", to: ["friend@example.com"], subject: "Draft subject" }] });
  });

  it("maintains constant-time mailbox counters across state changes", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "summary-counts", ["mail:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    await env.DB.batch([
      readyMessage("counter-inbox", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]'),
      readyMessage("counter-sent", "owner@example.com", "sent", '["friend@example.com"]'),
      env.DB.prepare(`INSERT INTO drafts (id, identity_address, recipients_json, cc_json, bcc_json)
        VALUES ('counter-draft', 'owner@example.com', '[]', '[]', '[]')`),
    ]);
    await env.DB.prepare(`UPDATE mailbox_counts SET updated_at = '2000-01-01 00:00:00'
      WHERE identity_address = 'owner@example.com'`).run();
    await env.DB.prepare(`UPDATE messages SET sender_authenticated = 1, status = 'ready', updated_at = CURRENT_TIMESTAMP
      WHERE id = 'counter-inbox'`).run();
    await env.DB.prepare(`INSERT INTO drafts (id, identity_address, recipients_json, cc_json, bcc_json, subject)
      VALUES ('counter-draft', 'owner@example.com', '[]', '[]', '[]', 'Updated')
      ON CONFLICT(id) DO UPDATE SET identity_address = excluded.identity_address, subject = excluded.subject,
        updated_at = CURRENT_TIMESTAMP`).run();
    const afterIrrelevantUpdates = await env.DB.prepare(`SELECT unread, inbox, sent, drafts, updated_at
      FROM mailbox_counts WHERE identity_address = 'owner@example.com'`)
      .first<{ unread: number; inbox: number; sent: number; drafts: number; updated_at: string }>();
    expect(afterIrrelevantUpdates).toEqual({ unread: 1, inbox: 1, sent: 1, drafts: 1, updated_at: "2000-01-01 00:00:00" });

    await env.DB.prepare("UPDATE messages SET unread = 0, starred = 1, folder = 'archive' WHERE id = 'counter-inbox'").run();

    const response = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/summary?identity=owner%40example.com", { headers: { Authorization: `Bearer ${issued.token}` } },
    ));
    expect(await response.json()).toEqual({ spam: 0, unread: 0, inbox: 0, sent: 1, starred: 1, archive: 1, trash: 0, drafts: 1 });

    await expect(env.DB.prepare(`UPDATE mailbox_counts SET inbox = -1
      WHERE identity_address = 'owner@example.com'`).run()).rejects.toThrow();

    await readyMessage("counter-move", "owner@example.com", "inbox", '[{"address":"owner@example.com"}]').run();
    await env.DB.prepare("UPDATE messages SET identity_address = 'billing@aws.example.com' WHERE id = 'counter-move'").run();
    const moved = await env.DB.prepare(`SELECT identity_address, inbox FROM mailbox_counts
      WHERE identity_address IN ('owner@example.com', 'billing@aws.example.com') ORDER BY identity_address`)
      .all<{ identity_address: string; inbox: number }>();
    expect(moved.results).toEqual([
      { identity_address: "billing@aws.example.com", inbox: 1 },
      { identity_address: "owner@example.com", inbox: 0 },
    ]);

    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages WHERE id = 'counter-sent'"),
      env.DB.prepare("DELETE FROM messages WHERE id = 'counter-move'"),
      env.DB.prepare("DELETE FROM drafts WHERE id = 'counter-draft'"),
    ]);
    const counts = await env.DB.prepare("SELECT * FROM mailbox_counts WHERE identity_address = 'owner@example.com'")
      .first<{ sent: number; drafts: number }>();
    expect(counts).toMatchObject({ sent: 0, drafts: 0 });
  });

  it("does not expose addresses through a mail-only snapshot", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "snapshot-mail-only", ["mail:read"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    const response = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/mailbox-snapshot?identity=owner%40example.com&includeAddresses=1",
      { headers: { Authorization: `Bearer ${issued.token}` } },
    ));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden", retryable: false });
  });

  it("uses indexes for every hot native mailbox read", async () => {
    const plans = await env.DB.batch<{ detail: string }>([
      env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages
        WHERE status = 'ready' AND identity_address = ?
          AND (received_at < ? OR (received_at = ? AND id < ?)) AND folder = ?
        ORDER BY received_at DESC, id DESC LIMIT ?`)
        .bind("owner@example.com", "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z", "~", "inbox", 51),
      env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages
        WHERE status = 'ready' AND identity_address = ?
          AND (received_at < ? OR (received_at = ? AND id < ?))
        ORDER BY received_at DESC, id DESC LIMIT ?`)
        .bind("owner@example.com", "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z", "~", 51),
      env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages
        WHERE status = 'ready' AND identity_address = ? AND starred = 1 AND folder != 'trash'
        ORDER BY received_at DESC, id DESC LIMIT ?`).bind("owner@example.com", 51),
      env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages
        WHERE thread_id = ? AND identity_address = ? AND status = 'ready'
        ORDER BY received_at DESC, id DESC LIMIT ?`).bind("thread", "owner@example.com", 101),
      env.DB.prepare(`EXPLAIN QUERY PLAN SELECT unread, inbox, sent, starred, archive, trash, drafts
        FROM mailbox_counts WHERE identity_address = ?`).bind("owner@example.com"),
    ]);
    for (const plan of plans) {
      const detail = plan.results.map((row) => row.detail).join("\n");
      expect(detail).toMatch(/USING (?:COVERING )?INDEX/);
      expect(detail).not.toMatch(/SCAN (?:messages|mailbox_counts)/);
    }
  });

  it("rebuilds counters when a preserved mailbox identity is enabled again", async () => {
    await env.DB.prepare(`INSERT INTO identities (address, display_name, zone_id, routing_rule_id)
      VALUES ('restored@example.com', 'Restored', 'zone-restored', 'rule-restored')`).run();
    await readyMessage("restored-message", "restored@example.com", "inbox", '[{"address":"restored@example.com"}]').run();
    await readyMessage("restored-delete", "restored@example.com", "inbox", '[{"address":"restored@example.com"}]').run();
    await env.DB.prepare("DELETE FROM identities WHERE address = 'restored@example.com'").run();
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = 'restored-message'").first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT inbox FROM mailbox_counts WHERE identity_address = 'restored@example.com'").first()).toBeNull();

    // Historical mail stays mutable even while its address is disabled. The
    // counter row is rebuilt from the final state if that identity returns.
    await env.DB.prepare("UPDATE messages SET unread = 0 WHERE id = 'restored-message'").run();
    await env.DB.prepare("DELETE FROM messages WHERE id = 'restored-delete'").run();
    expect(await env.DB.prepare("SELECT inbox FROM mailbox_counts WHERE identity_address = 'restored@example.com'").first()).toBeNull();

    await env.DB.prepare(`INSERT INTO identities (address, display_name, zone_id, routing_rule_id)
      VALUES ('restored@example.com', 'Restored', 'zone-restored', 'rule-restored-2')`).run();
    const restored = await env.DB.prepare(`SELECT unread, inbox, sent, drafts FROM mailbox_counts
      WHERE identity_address = 'restored@example.com'`).first<{ unread: number; inbox: number; sent: number; drafts: number }>();
    expect(restored).toEqual({ unread: 0, inbox: 1, sent: 0, drafts: 0 });
    await env.DB.prepare("DELETE FROM messages WHERE id = 'restored-message'").run();
    await env.DB.prepare("DELETE FROM identities WHERE address = 'restored@example.com'").run();
  });

  it("searches and manages remembered contacts inside the authorized inbox", async () => {
    const issued = await issueDeviceApiKey(workerEnv, "contacts", ["mail:read", "mail:write"],
      ["owner@example.com"], "2027-08-11T00:00:00.000Z", "integration-key");
    const headers = { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" };
    const created = await workerExports.default.fetch(new Request("https://mail.test/v1/contacts", {
      method: "POST", headers,
      body: JSON.stringify({ identity: "owner@example.com", address: "Friend@Example.com", displayName: "Friendly Person" }),
    }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ contact: { identityAddress: "owner@example.com",
      address: "friend@example.com", displayName: "Friendly Person", source: "manual", sendCount: 0,
      avatarColor: expect.stringMatching(/^#[0-9A-F]{6}$/) } });

    const searched = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/contacts?identity=owner%40example.com&query=friendly&limit=10", { headers },
    ));
    expect(searched.status).toBe(200);
    expect(await searched.json()).toMatchObject({ contacts: [{ address: "friend@example.com" }] });

    const renamed = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/contacts/friend%40example.com", { method: "PATCH", headers,
        body: JSON.stringify({ identity: "owner@example.com", displayName: "Best Friend" }) },
    ));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ contact: { displayName: "Best Friend" } });

    const forbidden = await workerExports.default.fetch(new Request("https://mail.test/v1/contacts", {
      method: "POST", headers,
      body: JSON.stringify({ identity: "billing@aws.example.com", address: "outside@example.com" }),
    }));
    expect(forbidden.status).toBe(403);

    const deleted = await workerExports.default.fetch(new Request(
      "https://mail.test/v1/contacts/friend%40example.com?identity=owner%40example.com", { method: "DELETE", headers },
    ));
    expect(deleted.status).toBe(200);
  });
});

function readyMessage(id: string, identity: string, folder: "inbox" | "sent", recipientsJson: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO messages
    (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-11T12:00:00.000Z', 10, 'ready', ?)`).bind(
    id, id, folder === "sent" ? "outbound" : "inbound", folder, folder === "sent" ? identity : "sender@example.com",
    recipientsJson, `raw/${id}.eml`, identity,
  );
}

async function stageInbound(id: string, raw: string): Promise<InboundJob> {
  const rawKey = `raw/${id}.eml`;
  const receivedAt = "2026-08-11T10:00:00.000Z";
  await env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
  await env.DB.prepare(`INSERT INTO messages
    (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
    VALUES (?, ?, 'inbound', 'inbox', 'sender@example.com', ?, ?, ?, ?, 'pending', 'owner@example.com')`)
    .bind(id, id, JSON.stringify([{ address: "owner@example.com" }]), rawKey, receivedAt, raw.length).run();
  return { id, rawKey, envelopeFrom: "sender@example.com", envelopeTo: "owner@example.com", receivedAt, size: raw.length };
}

function mimeWithAttachments(count: number): string {
  const boundary = "integration-boundary";
  const parts = [
    "From: Sender <sender@example.com>",
    "To: owner@example.com",
    "Subject: Integration test",
    "Message-ID: <integration@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Hello from the integration test.",
  ];
  for (let index = 0; index < count; index += 1) {
    parts.push(`--${boundary}`, `Content-Type: text/plain; name="file-${index}.txt"`,
      "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="file-${index}.txt"`, "", btoa(`file-${index}`));
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

function outboundInput(recipients: { to: string[]; cc: string[]; bcc: string[] }) {
  return {
    keyId: "integration-key",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    requestHash: "request-hash",
    threadId: "thread-id",
    from: "owner@example.com",
    fromName: "Owner",
    ...recipients,
    subject: "Reliable delivery",
    text: "Hello",
    attachments: [],
  };
}

function withEmail(send: (message: EmailMessage) => Promise<EmailSendResult>): Env {
  const email = { send } as SendEmail;
  return { DB: env.DB, MAIL: env.MAIL, EMAIL: email } as Env;
}

async function pushTestEnv(): Promise<Env> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const wrapped = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return {
    DB: env.DB,
    APNS_KEY_ID: "TESTKEY01",
    APNS_TEAM_ID: "TESTTEAM01",
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`,
  } as Env;
}
