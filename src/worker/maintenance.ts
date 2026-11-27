import type { Env, InboundJob } from "./types";

interface StaleInboundRow {
  id: string;
  sender_address: string;
  recipients_json: string;
  raw_key: string;
  received_at: string;
  size: number;
}

export interface MaintenanceResult {
  recoveredInbound: number;
  missingInboundObjects: number;
  staleOutbound: number;
  unresolvedOutbound: number;
  failedMessages: number;
  queueBacklog: number | null;
  queueOldestAgeSeconds: number | null;
  cleanupRan: boolean;
}

export async function runMaintenance(env: Env, cleanup: boolean): Promise<MaintenanceResult> {
  const staleOutbound = await env.DB.prepare(`UPDATE send_requests SET status = 'unknown',
    error_message = 'Execution stopped before a durable provider outcome was recorded', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('processing', 'reserved', 'sending') AND updated_at < datetime('now', '-15 minutes')`).run();
  await env.DB.batch([
    env.DB.prepare(`UPDATE send_recipients SET status = 'unknown',
      error_message = 'Execution stopped before a durable provider outcome was recorded', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'sending' AND updated_at < datetime('now', '-15 minutes')`),
    env.DB.prepare(`UPDATE messages SET status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE direction = 'outbound' AND status = 'pending' AND id IN
        (SELECT message_row_id FROM send_requests WHERE status = 'unknown' AND message_row_id IS NOT NULL)`),
  ]);

  const staleInbound = await env.DB.prepare(`SELECT id, sender_address, recipients_json, raw_key, received_at, size
    FROM messages WHERE direction = 'inbound' AND status = 'pending'
      AND updated_at < datetime('now', '-15 minutes') ORDER BY updated_at LIMIT 50`).all<StaleInboundRow>();
  let recoveredInbound = 0;
  let missingInboundObjects = 0;
  for (const row of staleInbound.results) {
    const object = await env.MAIL.head(row.raw_key);
    const envelopeTo = firstRecipient(row.recipients_json);
    if (!object || !envelopeTo) {
      await env.DB.prepare("UPDATE messages SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(row.id).run();
      missingInboundObjects += 1;
      continue;
    }
    const job: InboundJob = { id: row.id, rawKey: row.raw_key, envelopeFrom: row.sender_address,
      envelopeTo, receivedAt: row.received_at, size: row.size };
    await env.MAIL_QUEUE.send(job);
    await env.DB.prepare("UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id).run();
    recoveredInbound += 1;
  }

  if (cleanup) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now', '-180 days')"),
      env.DB.prepare("DELETE FROM ai_runs WHERE created_at < datetime('now', '-90 days')"),
      env.DB.prepare("DELETE FROM autopilot_actions WHERE created_at < datetime('now', '-180 days')"),
      env.DB.prepare("DELETE FROM push_notification_outbox WHERE created_at < datetime('now', '-24 hours') OR attempts >= 10"),
      env.DB.prepare("DELETE FROM push_devices WHERE disabled_at IS NOT NULL AND updated_at < datetime('now', '-30 days')"),
      env.DB.prepare(`DELETE FROM send_requests WHERE status IN ('complete', 'failed') AND created_at < datetime('now', '-30 days')`),
      env.DB.prepare("DELETE FROM send_requests WHERE created_at < datetime('now', '-90 days')"),
      env.DB.prepare("DELETE FROM webauthn_challenges WHERE datetime(expires_at) <= datetime('now')"),
      env.DB.prepare("DELETE FROM web_sessions WHERE datetime(expires_at) <= datetime('now')"),
      env.DB.prepare("DELETE FROM native_authorization_requests WHERE datetime(expires_at) <= datetime('now')"),
      env.DB.prepare("DELETE FROM native_authorization_codes WHERE datetime(expires_at) <= datetime('now')"),
      env.DB.prepare("DELETE FROM native_sessions WHERE datetime(expires_at) <= datetime('now')"),
    ]);
  }

  const [outbound, messages, queueMetrics] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM send_requests
      WHERE status IN ('processing', 'reserved', 'sending', 'partial', 'unknown')`).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE status = 'failed' AND updated_at >= datetime('now', '-7 days')")
      .first<{ count: number }>(),
    env.MAIL_QUEUE.metrics().catch(() => null),
  ]);
  const queueOldestAgeSeconds = queueMetrics?.oldestMessageTimestamp
    ? Math.max(0, Math.round((Date.now() - queueMetrics.oldestMessageTimestamp.getTime()) / 1_000))
    : null;
  const result: MaintenanceResult = {
    recoveredInbound,
    missingInboundObjects,
    staleOutbound: staleOutbound.meta.changes,
    unresolvedOutbound: outbound?.count ?? 0,
    failedMessages: messages?.count ?? 0,
    queueBacklog: queueMetrics?.backlogCount ?? null,
    queueOldestAgeSeconds,
    cleanupRan: cleanup,
  };
  const unhealthy = result.missingInboundObjects > 0 || result.unresolvedOutbound > 0 || result.failedMessages > 0
    || (result.queueOldestAgeSeconds !== null && result.queueOldestAgeSeconds >= 900);
  const event = { event: "scheduled-mail-maintenance", unhealthy, ...result };
  if (unhealthy) console.error(JSON.stringify(event));
  else console.log(JSON.stringify(event));
  return result;
}

function firstRecipient(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first: unknown = parsed[0];
    if (typeof first === "string") return first.toLowerCase();
    if (typeof first === "object" && first !== null && "address" in first && typeof first.address === "string") {
      return first.address.toLowerCase();
    }
  } catch { /* invalid stored recipient data */ }
  return null;
}
