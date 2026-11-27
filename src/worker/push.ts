import type { Env, MessageRow, PushJob } from "./types";

const DEFAULT_APNS_TOPIC = "com.example.lmail";
const encoder = new TextEncoder();

type PushDeviceRow = { id: string; device_token: string; environment: "development" | "production" };
type PushMessage = Pick<MessageRow, "id" | "thread_id" | "identity_address" | "subject" | "sender_name" | "sender_address">;

export async function enqueuePushNotification(env: Env, messageId: string): Promise<void> {
  await env.MAIL_QUEUE.send({ kind: "push", messageId });
}

export async function enqueuePendingPushNotifications(env: Env, limit = 25): Promise<number> {
  const rows = await env.DB.prepare(`SELECT message_id FROM push_notification_outbox
    WHERE (status = 'pending' OR (status = 'processing' AND locked_at < datetime('now', '-10 minutes')))
      AND attempts < 10 AND created_at >= datetime('now', '-24 hours')
    ORDER BY attempts ASC, created_at ASC LIMIT ?`).bind(limit).all<{ message_id: string }>();
  await Promise.all(rows.results.map((row) => enqueuePushNotification(env, row.message_id)));
  return rows.results.length;
}

export async function deliverPushJob(env: Env, job: PushJob): Promise<void> {
  const claimed = await env.DB.prepare(`UPDATE push_notification_outbox
    SET status = 'processing', locked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE message_id = ? AND (status = 'pending' OR (status = 'processing' AND locked_at < datetime('now', '-10 minutes')))
    RETURNING identity_address, attempts`).bind(job.messageId).first<{ identity_address: string; attempts: number }>();
  if (!claimed) return;
  try {
    const message = await env.DB.prepare(`SELECT id, thread_id, identity_address, subject, sender_name, sender_address
      FROM messages WHERE id = ? AND direction = 'inbound' AND status = 'ready'
        -- Mail the autopilot filed away or flagged is reported in the brief, not announced.
        AND folder = 'inbox' AND spam = 0`)
      .bind(job.messageId).first<PushMessage>();
    if (!message?.identity_address) {
      await env.DB.prepare("DELETE FROM push_notification_outbox WHERE message_id = ?").bind(job.messageId).run();
      return;
    }
    await sendNewMailPush(env, message);
    await env.DB.prepare("DELETE FROM push_notification_outbox WHERE message_id = ?").bind(job.messageId).run();
  } catch (error) {
    if (claimed.attempts + 1 >= 10) {
      await env.DB.prepare("DELETE FROM push_notification_outbox WHERE message_id = ?").bind(job.messageId).run();
    } else {
      await env.DB.prepare(`UPDATE push_notification_outbox SET status = 'pending', attempts = attempts + 1,
        locked_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE message_id = ?`).bind(job.messageId).run();
    }
    throw error;
  }
}

async function sendNewMailPush(env: Env, message: PushMessage): Promise<void> {
  const devices = await env.DB.prepare(`SELECT pd.id, pd.device_token, pd.environment FROM push_devices pd
    JOIN api_keys k ON k.id = pd.key_id
    WHERE pd.disabled_at IS NULL AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))
      AND (pd.native_session_hash IS NULL OR EXISTS (
        SELECT 1 FROM native_sessions ns
        WHERE ns.token_hash = pd.native_session_hash AND datetime(ns.expires_at) > datetime('now')
      ))
      AND EXISTS (
        SELECT 1 FROM json_each(k.scopes_json) WHERE value IN ('mail:read', 'mail:*', '*')
      )
      AND (k.allowed_identities_json IS NULL OR EXISTS (
        SELECT 1 FROM json_each(k.allowed_identities_json) WHERE lower(value) = lower(?)
      ))
      AND EXISTS (
        SELECT 1 FROM identities i WHERE i.address = ? AND i.enabled = 1
      )
      AND EXISTS (
        SELECT 1 FROM json_each(pd.identities_json) WHERE lower(value) = lower(?)
      ) ORDER BY pd.id`).bind(message.identity_address, message.identity_address, message.identity_address).all<PushDeviceRow>();
  if (devices.results.length === 0) return;
  const authorization = `bearer ${await apnsProviderToken(env)}`;
  const payload = JSON.stringify(newMailPayload(message));
  const results = await Promise.all(devices.results.map(async (device) => {
    const host = device.environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
    const response = await fetch(`https://${host}/3/device/${device.device_token}`, {
      method: "POST",
      headers: {
        authorization,
        "apns-topic": (env.APNS_TOPIC ?? "").trim() || DEFAULT_APNS_TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1_000) + 86_400),
        "apns-id": await deterministicApnsId(message.id, device.id),
        "content-type": "application/json",
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      await env.DB.prepare(`UPDATE push_devices SET failure_count = 0, last_success_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(device.id).run();
      await response.body?.cancel();
      return null;
    }
    const reason = await apnsFailureReason(response);
    if (response.status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered") {
      await env.DB.prepare(`UPDATE push_devices SET disabled_at = CURRENT_TIMESTAMP, failure_count = failure_count + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(device.id).run();
      return null;
    }
    await env.DB.prepare(`UPDATE push_devices SET failure_count = failure_count + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(device.id).run();
    return `APNs ${response.status}${reason ? ` ${reason}` : ""}`;
  }));
  const retryable = results.find((result) => result !== null);
  if (retryable) throw new Error(retryable);
}

export function newMailPayload(message: PushMessage): Record<string, unknown> {
  const sender = clean(message.sender_name, 80) || clean(message.sender_address, 120) || "New message";
  const subject = clean(message.subject, 180) || "No Subject";
  return {
    aps: {
      alert: { title: sender, body: subject },
      sound: "default",
      "thread-id": message.thread_id,
      "mutable-content": 0,
    },
    messageId: message.id,
    identity: message.identity_address,
    folder: "inbox",
  };
}

async function apnsProviderToken(env: Env): Promise<string> {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
    throw new Error("APNs provider credentials are not configured");
  }
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const claims = base64Url(encoder.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1_000) })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(env.APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function pemBytes(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function deterministicApnsId(messageId: string, deviceId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${messageId}:${deviceId}`)));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function apnsFailureReason(response: Response): Promise<string | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && "reason" in value && typeof value.reason === "string"
      ? value.reason : null;
  } catch { return null; }
}

function clean(value: string | null | undefined, maximum: number): string {
  return (value ?? "").replaceAll(/[\r\n\0]/g, " ").trim().slice(0, maximum);
}
