import { Hono } from "hono";
import { api } from "./api";
import { runAutopilotSweep } from "./autopilot";
import { securityHeaders } from "./auth";
import { maybeWriteDailyBrief } from "./brief";
import { runExternalSync } from "./external";
import { runKnowledgeGraphSync } from "./kg";
import { acceptInbound, processInbound } from "./inbound";
import { runMaintenance } from "./maintenance";
import { deliverPushJob, enqueuePendingPushNotifications } from "./push";
import { isolateMtaStsHosts } from "./mta-sts";
import { passkeys } from "./passkeys";
import { draftReply } from "./reply-drafts";
import { isDraftJob, isPushJob, type Env, type MailQueueJob } from "./types";

const app = new Hono<{ Bindings: Env }>();
app.use("*", isolateMtaStsHosts);
app.use("*", securityHeaders);
app.get("/health", (c) => c.json({ ok: true, service: c.env.APP_NAME, mode: "mail-client", version: 2 }));
app.route("/auth", passkeys);
app.route("/v1", api);
app.get("/", (c) =>
  c.json({
    service: c.env.APP_NAME,
    mode: "mail-client",
    version: 2,
    description: "Private mail API.",
  }));
app.all("*", (c) => c.json({ error: "Not found" }, 404));
// /v1 has its own handler; this one covers /auth and everything else, so an
// unexpected failure is logged and answered as JSON without any detail.
app.onError((error, c) => {
  console.error("Request failed", { path: c.req.path, error: String(error).slice(0, 500) });
  return c.json({ error: "Internal server error", code: "internal_error", retryable: true }, 500, { "Cache-Control": "no-store" });
});

export default {
  fetch: app.fetch,
  email: acceptInbound,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime);
    await Promise.all([
      runMaintenance(env, scheduledAt.getUTCHours() === 3 && scheduledAt.getUTCMinutes() === 15),
      maybeWriteDailyBrief(env, scheduledAt)
        .then((result) => { if (result.written) console.log(JSON.stringify({ event: "autopilot-brief", ...result })); })
        .catch((error) => console.error(JSON.stringify({ event: "autopilot-brief-failed", error: String(error).slice(0, 500) }))),
      enqueuePendingPushNotifications(env),
      runExternalSync(env, { maxMessages: 40, deadlineMs: 90_000 })
        .then((report) => console.log(JSON.stringify({ event: "external-sync",
          done: report.done, synced: report.syncedMessages,
          errors: report.accounts.filter((account) => !account.ok).map((account) => account.error ?? account.identity) })))
        .catch((error) => console.error(JSON.stringify({ event: "external-sync-failed", error: String(error).slice(0, 500) })))
        // Triage what the sync left untriaged (backfill, outages), then index
        // whatever the sync (and any other path) just made ready.
        .then(() => runAutopilotSweep(env, { maxMessages: 25, deadlineMs: 60_000 }))
        .then((report) => console.log(JSON.stringify({ event: "autopilot-sweep", ...report })))
        .catch((error) => console.error(JSON.stringify({ event: "autopilot-sweep-failed", error: String(error).slice(0, 500) })))
        .then(() => runKnowledgeGraphSync(env, { maxMessages: 30, deadlineMs: 120_000 }))
        .then((report) => console.log(JSON.stringify({ event: "kg-sync", ...report })))
        .catch((error) => console.error(JSON.stringify({ event: "kg-sync-failed", error: String(error).slice(0, 500) }))),
    ]);
  },
  async queue(batch: MessageBatch<MailQueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (isPushJob(job)) await deliverPushJob(env, job);
        else if (isDraftJob(job)) await draftReply(env, job.messageId);
        else await processInbound(job, env);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: isPushJob(job) ? "push-delivery-failed" : isDraftJob(job) ? "draft-failed" : "inbound-processing-failed",
          id: isPushJob(job) || isDraftJob(job) ? job.messageId : job.id,
          queue: batch.queue, error: String(error).slice(0, 1_000) }));
        if (batch.queue.endsWith("-dlq")) {
          // A reply draft that failed five times is dropped: the brief still lists the mail.
          if (isPushJob(job)) {
            await env.DB.prepare(`UPDATE push_notification_outbox SET status = 'pending', locked_at = NULL,
              updated_at = CURRENT_TIMESTAMP WHERE message_id = ?`).bind(job.messageId).run();
          } else if (!isDraftJob(job)) {
            await env.DB.prepare("UPDATE messages SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .bind(job.id).run();
          }
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env, MailQueueJob>;
