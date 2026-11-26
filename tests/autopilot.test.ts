import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueApiKey, issueDeviceApiKey } from "../src/worker/auth";
import { alertKey, decide, listRules, resolves, tidyInbox, readAutopilotSettings, runAutopilotSweep, undoAction, writeAutopilotSettings, type ActionRow, type MessageState } from "../src/worker/autopilot";
import { maybeWriteDailyBrief, writeDailyBrief } from "../src/worker/brief";
import { processInbound } from "../src/worker/inbound";
import { cleanDraft, draftReply, ownText, replySubject } from "../src/worker/reply-drafts";
import { CATEGORIES, combine, triageMail, type Triage } from "../src/worker/triage";
import type { Env, InboundJob, MailQueueJob } from "../src/worker/types";

const OWNER = "owner@example.com";
const EXTERNAL = "external@ext.example.org";

interface Verdict {
  category?: keyof typeof CATEGORIES;
  confidence?: number;
  spam?: number;
  needsReply?: number;
  urgency?: number;
}

interface Fake {
  env: Env;
  calls: Array<{ model: string; input: { messages?: Array<{ role: string; content: string }>; state?: string } }>;
  queued: MailQueueJob[];
}

function clefAnswer(verdict: Verdict) {
  const category = verdict.category ?? "notification";
  const confidence = verdict.confidence ?? 0.9;
  const others = Object.keys(CATEGORIES).length - 1;
  const probabilities = Object.fromEntries(Object.keys(CATEGORIES)
    .map((key) => [key, key === category ? confidence : (1 - confidence) / others]));
  return {
    answers: {
      category: { type: "choice", choice: category, probabilities, confidence },
      spam: { type: "noul", noul: verdict.spam ?? 0.02 },
      needs_reply: { type: "noul", noul: verdict.needsReply ?? 0.05 },
      urgency: { type: "score", score: verdict.urgency ?? 0 },
    },
    usage: { input_tokens: 400, output_tokens: 0 },
  };
}

/** Workers AI and the queue, faked. A null verdict makes every triage model fail. */
function fake(verdict: Verdict | null, text = "Hello Taylor,\n\nSounds good, I will send it tonight.\n\nBest,\nOwner",
  failing: string[] = []): Fake {
  const calls: Fake["calls"] = [];
  const queued: MailQueueJob[] = [];
  const run = async (model: string, input: Fake["calls"][number]["input"]) => {
    calls.push({ model, input });
    if (failing.includes(model)) throw new Error(`${model} unavailable`);
    if (model.includes("clef")) {
      if (!verdict) throw new Error("AI unavailable");
      return clefAnswer(verdict);
    }
    return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 900, completion_tokens: 60 } };
  };
  const queue = { send: async (job: MailQueueJob) => { queued.push(job); }, sendBatch: async () => {}, metrics: async () => null };
  return { env: { ...(env as unknown as Env), AI: { run }, MAIL_QUEUE: queue } as unknown as Env, calls, queued };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM autopilot_actions"),
    env.DB.prepare("DELETE FROM drafts"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM ai_runs"),
    env.DB.prepare("DELETE FROM push_notification_outbox"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM autopilot_settings WHERE key LIKE 'autopilot.%'"),
  ]);
});

const triage = (overrides: Partial<Triage> = {}): Triage => ({ category: "newsletter", confidence: 0.9, spam: 0.05, needsReply: 0.05,
  urgency: 0, model: "clef+clef-flash", ...overrides });
const inbox = (overrides: Partial<MessageState> = {}): MessageState => ({ folder: "inbox", unread: 1, starred: 0, spam: 0,
  senderAddress: "news@example.com", identityAddress: OWNER, ...overrides });

describe("triage", () => {
  it("averages the two models and reads the most likely category", () => {
    const result = combine([
      { model: "@cf/cloudflare/clef", answers: clefAnswer({ category: "receipt", confidence: 0.9, spam: 0.9 }).answers },
      { model: "@cf/cloudflare/clef-flash", answers: clefAnswer({ category: "receipt", confidence: 0.7, spam: 0.6, urgency: 2 }).answers },
    ]);
    expect(result).toMatchObject({ category: "receipt", spam: 0.75, urgency: 1, model: "clef+clef-flash" });
    expect(result?.confidence).toBeCloseTo(0.8);
  });

  it("goes on with one model when the other fails, and gives up when both do", async () => {
    const input = { messageId: null, senderName: "", senderAddress: "a@example.com", recipients: OWNER, subject: "Hi",
      receivedAt: "2026-10-23T08:00:00.000Z", text: "Hello", identityAddress: OWNER };
    const one = fake({ category: "personal" }, undefined, ["@cf/cloudflare/clef-flash"]);
    expect((await triageMail(one.env, input))?.model).toBe("clef");
    expect(await triageMail(fake(null).env, input)).toBeNull();
    // Both runs are billed, the failed one too.
    const runs = await env.DB.prepare("SELECT model, kind FROM ai_runs WHERE kind = 'triage' ORDER BY model").all<{ model: string }>();
    expect(runs.results.map((run) => run.model)).toEqual(["@cf/cloudflare/clef"]);
  });

  it("tells the models who the mailbox belongs to", async () => {
    const recorder = fake({ category: "school" });
    await triageMail(recorder.env, { messageId: null, senderName: "Taylor Reed", senderAddress: "t.reed@ext.example.org",
      recipients: EXTERNAL, subject: "Project Notes", receivedAt: "2026-10-12T21:44:00.000Z", text: "Please send by tomorrow.", identityAddress: EXTERNAL });
    expect(recorder.calls[0]?.input.state).toContain("Mailbox of Owner (owner@example.com)");
    expect(recorder.calls[0]?.input.state).toContain("From: Taylor Reed <t.reed@ext.example.org>");
  });
});

describe("decide", () => {
  it("flags spam from strangers only", async () => {
    const settings = await readAutopilotSettings(env as unknown as Env);
    const rules = await listRules(env as unknown as Env);
    expect(decide(triage({ spam: 0.85 }), inbox(), rules, { trusted: false, settings })).toMatchObject({ spam: 1, folder: "inbox",
      actions: [{ action: "spam" }] });
    expect(decide(triage({ spam: 0.95 }), inbox(), rules, { trusted: true, settings }).spam).toBe(0);
    expect(decide(triage({ spam: 0.75 }), inbox(), rules, { trusted: false, settings }).spam).toBe(0);
  });

  it("files confident newsletters, receipts and calm notifications, and leaves the rest", async () => {
    const settings = await readAutopilotSettings(env as unknown as Env);
    const rules = await listRules(env as unknown as Env);
    const run = (overrides: Partial<Triage>) => decide(triage(overrides), inbox(), rules, { trusted: false, settings });
    expect(run({})).toMatchObject({ folder: "archive", unread: 0, actions: [{ action: "archive", ruleId: "default-newsletter" }] });
    expect(run({ confidence: 0.7 }).folder).toBe("inbox");
    expect(run({ category: "receipt", urgency: 1 }).folder).toBe("archive");
    expect(run({ category: "notification", urgency: 0 }).folder).toBe("archive");
    expect(run({ category: "notification", urgency: 1 }).folder).toBe("inbox");
    expect(run({ category: "code" }).folder).toBe("inbox");
    expect(run({ category: "personal" }).folder).toBe("inbox");
  });

  it("never files mail a person is waiting on, and drafts a reply to people and school", async () => {
    const settings = await readAutopilotSettings(env as unknown as Env);
    const rules = await listRules(env as unknown as Env);
    expect(decide(triage({ needsReply: 0.8 }), inbox(), rules, { trusted: false, settings })).toMatchObject({ folder: "inbox", draft: false });
    expect(decide(triage({ category: "school", needsReply: 0.8 }), inbox(), rules, { trusted: true, settings }).draft).toBe(true);
    expect(decide(triage({ category: "personal", needsReply: 0.4 }), inbox(), rules, { trusted: true, settings }).draft).toBe(false);
  });

  it("does nothing but flag spam while paused", async () => {
    const settings = await writeAutopilotSettings(env as unknown as Env, { enabled: false });
    const rules = await listRules(env as unknown as Env);
    expect(decide(triage(), inbox(), rules, { trusted: false, settings })).toMatchObject({ folder: "inbox", actions: [] });
    expect(decide(triage({ category: "school", needsReply: 0.9 }), inbox(), rules, { trusted: false, settings }).draft).toBe(false);
    expect(decide(triage({ spam: 0.9 }), inbox(), rules, { trusted: false, settings }).spam).toBe(1);
  });

  it("applies a rule only to its own address and sender", async () => {
    const settings = await readAutopilotSettings(env as unknown as Env);
    const rule = { id: "r", category: "agent" as const, action: "read" as const, identity_address: OWNER, sender_match: "@agents.example.org",
      max_urgency: 3, min_confidence: 0.8, enabled: 1, created_at: "", updated_at: "" };
    const agent = triage({ category: "agent" });
    expect(decide(agent, inbox({ senderAddress: "bot@agents.example.org" }), [rule], { trusted: false, settings }).unread).toBe(0);
    expect(decide(agent, inbox({ senderAddress: "bot@other.example.org" }), [rule], { trusted: false, settings }).unread).toBe(1);
    expect(decide(agent, inbox({ senderAddress: "bot@agents.example.org", identityAddress: EXTERNAL }), [rule], { trusted: false, settings }).unread).toBe(1);
  });
});

describe("arrival", () => {
  it("stores spam, keeps it out of the inbox counters, logs it and sends no push", async () => {
    const job = await stageInbound("spam-inbound", mime("SEO Agency <sales@spam.example.net>", "AI-Driven Growth for Your Example.com"));
    const ai = fake({ category: "spam", spam: 0.97 });
    await processInbound(job, ai.env);

    const row = await env.DB.prepare("SELECT status, spam, spam_model, folder, triage_category, triaged_at FROM messages WHERE id = ?")
      .bind(job.id).first<Record<string, unknown>>();
    // Kept, not moved: the row stays where it landed and is only hidden.
    expect(row).toMatchObject({ status: "ready", spam: 1, spam_model: "clef+clef-flash", folder: "inbox", triage_category: "spam" });
    expect(row?.triaged_at).not.toBeNull();
    const counts = await env.DB.prepare("SELECT inbox, unread, spam FROM mailbox_counts WHERE identity_address = ?")
      .bind(OWNER).first<{ inbox: number; unread: number; spam: number }>();
    expect(counts).toMatchObject({ inbox: 0, unread: 0, spam: 1 });
    expect(await outboxCount(job.id)).toBe(0);
    expect(ai.queued).toEqual([]);
    expect(await actions(job.id)).toEqual(["spam"]);
  });

  it("files a newsletter in the archive without announcing it", async () => {
    const job = await stageInbound("newsletter", mime("Exa <hello@exa.ai>", "What's new at Exa"));
    const ai = fake({ category: "newsletter", confidence: 0.95 });
    await processInbound(job, ai.env);

    const row = await env.DB.prepare("SELECT folder, unread, spam FROM messages WHERE id = ?").bind(job.id).first();
    expect(row).toEqual({ folder: "archive", unread: 0, spam: 0 });
    expect(await outboxCount(job.id)).toBe(0);
    expect(ai.queued).toEqual([]);
    expect(await actions(job.id)).toEqual(["archive"]);
  });

  it("announces wanted mail and queues a draft when a person waits on a reply", async () => {
    const job = await stageInbound("question", mime("Alex <alex@example.org>", "Tuesday?"));
    const ai = fake({ category: "personal", needsReply: 0.9 });
    await processInbound(job, ai.env);

    expect(await env.DB.prepare("SELECT folder FROM messages WHERE id = ?").bind(job.id).first()).toEqual({ folder: "inbox" });
    expect(ai.queued).toEqual([{ kind: "push", messageId: job.id }, { kind: "draft", messageId: job.id }]);
  });

  it("never marks mail from a correspondent as spam", async () => {
    await env.DB.prepare(`INSERT INTO contacts (identity_address, address, display_name, send_count)
      VALUES (?, 'family@example.org', 'Family', 1)`).bind(OWNER).run();
    const job = await stageInbound("contact-inbound", mime("Family <family@example.org>", "hello"), "family@example.org");
    await processInbound(job, fake({ category: "spam", spam: 0.99 }).env);
    expect(await env.DB.prepare("SELECT spam, folder FROM messages WHERE id = ?").bind(job.id).first()).toEqual({ spam: 0, folder: "inbox" });
  });

  it("delivers untriaged when the models are down, for the sweep to finish later", async () => {
    const job = await stageInbound("outage", mime("AWS <no-reply@sns.amazonaws.com>", 'ALARM: "restore-verify-failure"'));
    const down = fake(null);
    await processInbound(job, down.env);
    expect(await env.DB.prepare("SELECT folder, spam, triaged_at, spam_model FROM messages WHERE id = ?").bind(job.id).first())
      .toEqual({ folder: "inbox", spam: 0, triaged_at: null, spam_model: null });
    expect(down.queued).toEqual([{ kind: "push", messageId: job.id }]);
  });

  it("stops spending once the daily cap is reached", async () => {
    await writeAutopilotSettings(env as unknown as Env, { dailyCapUsd: 0 });
    const job = await stageInbound("capped", mime("Exa <hello@exa.ai>", "What's new at Exa"));
    const ai = fake({ category: "newsletter" });
    await processInbound(job, ai.env);
    expect(ai.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT folder, triaged_at FROM messages WHERE id = ?").bind(job.id).first())
      .toEqual({ folder: "inbox", triaged_at: null });
  });

  it("clearing a false positive puts the message back in the inbox counters", async () => {
    const job = await stageInbound("false-positive", mime("Alex <alex@example.org>", "Invitation: Sync Meeting"));
    await processInbound(job, fake({ spam: 0.9 }).env);
    const [action] = (await env.DB.prepare("SELECT * FROM autopilot_actions WHERE message_id = ?").bind(job.id).all<ActionRow>()).results;
    expect(await undoAction(env as unknown as Env, action!)).toEqual({ undone: true });
    const counts = await env.DB.prepare("SELECT inbox, unread, spam FROM mailbox_counts WHERE identity_address = ?")
      .bind(OWNER).first<{ inbox: number; unread: number; spam: number }>();
    expect(counts).toMatchObject({ inbox: 1, unread: 1, spam: 0 });
  });
});

describe("repeating alerts", () => {
  it("reduces an alert subject to the problem it names", () => {
    expect(alertKey("[App API] ALERT: sync job failing")).toBe(alertKey("[App API] RESOLVED: sync job failing"));
    expect(alertKey("[backup] bulk backup is held after a mass change: 2026-10-21T20:19:05+02:00: 5590"))
      .toBe(alertKey("[backup] bulk backup is held after a mass change: 2026-10-22T08:00:00+02:00: 6120"));
    expect(alertKey("Compute 1 is not reachable")).not.toBe(alertKey("Compute 2 is not reachable"));
    expect(resolves(alertKey("Resolved: Compute 1 is not reachable"), alertKey("[Cluster] Compute 1 is not reachable"))).toBe(true);
    expect(resolves(alertKey("Resolved: Compute 1 is not reachable"), alertKey("Cluster incident: Compute 1 is not reachable"))).toBe(true);
    expect(resolves(alertKey("Resolved: Compute 1 is not reachable"), alertKey("Compute 11 is not reachable"))).toBe(false);
    expect(resolves(alertKey("Resolved: down"), alertKey("[Cluster] down"))).toBe(false);
    expect(alertKey('OK: "service-billing-health-breach" in EU (Stockholm)')).toBe(alertKey('ALARM: "service-billing-health-breach" in EU (Stockholm)'));
  });

  it("tidies alerts that were already in the inbox", async () => {
    const stage = async (id: string, subject: string, at: string) => {
      await stageReady(id, OWNER, "", "alerts@ops.example.org", subject, subject, at);
      await env.DB.prepare("UPDATE messages SET triage_category = 'notification', triaged_at = ? WHERE id = ?").bind(at, id).run();
    };
    const hour = (h: number) => new Date(Date.now() - (10 - h) * 3_600_000).toISOString();
    await stage("a1", "[Cluster] Compute 1 is not reachable", hour(1));
    await stage("a2", "Cluster incident: Compute 1 is not reachable", hour(2));
    await stage("a3", "Resolved: Compute 1 is not reachable", hour(3));
    await stage("b1", "Cluster fleet: free capacity fell below the buffer", hour(4));
    await stage("b2", "Cluster fleet: free capacity fell below the buffer", hour(5));
    await stage("c1", "[Cluster] Compute 2 is not reachable", hour(6));
    await stage("d1", 'ALARM: "service-billing-health-breach" in EU (Stockholm)', hour(7));
    await stage("d2", 'OK: "service-billing-health-breach" in EU (Stockholm)', hour(8));
    expect(await tidyInbox(env as unknown as Env)).toBe(6);
    const rows = await env.DB.prepare("SELECT id, folder FROM messages ORDER BY id").all();
    expect(rows.results).toEqual([{ id: "a1", folder: "archive" }, { id: "a2", folder: "archive" }, { id: "a3", folder: "archive" },
      { id: "b1", folder: "archive" }, { id: "b2", folder: "inbox" }, { id: "c1", folder: "inbox" },
      { id: "d1", folder: "archive" }, { id: "d2", folder: "archive" }]);
    expect(await tidyInbox(env as unknown as Env)).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM autopilot_actions").first<{ count: number }>())?.count).toBe(6);
  });

  it("keeps only the newest copy in the inbox and does not announce a repeat of an unread one", async () => {
    const first = await stageInbound("fleet-1", mime("Cluster <alerts@ops.example.org>", "Cluster fleet: free capacity fell below the buffer"),
      "alerts@ops.example.org", "2026-10-22T08:00:00.000Z");
    await processInbound(first, fake({ category: "notification", urgency: 2 }).env);
    const second = await stageInbound("fleet-2", mime("Cluster <alerts@ops.example.org>", "Cluster fleet: free capacity fell below the buffer"),
      "alerts@ops.example.org", "2026-10-22T09:00:00.000Z", "fleet-2@example.com");
    const ai = fake({ category: "notification", urgency: 2 });
    await processInbound(second, ai.env);

    const rows = await env.DB.prepare("SELECT id, folder, unread FROM messages ORDER BY id").all();
    expect(rows.results).toEqual([{ id: "fleet-1", folder: "archive", unread: 0 }, { id: "fleet-2", folder: "inbox", unread: 1 }]);
    expect(await actions("fleet-1")).toEqual(["archive"]);
    expect(ai.queued).toEqual([]);
    expect(await outboxCount("fleet-2")).toBe(0);

    // A redelivered job moves nothing twice and logs nothing twice.
    await env.DB.prepare("UPDATE messages SET status = 'pending' WHERE id = 'fleet-2'").run();
    await processInbound(second, fake({ category: "notification", urgency: 2 }).env);
    expect(await actions("fleet-1")).toEqual(["archive"]);
  });

  it("files a resolved alert together with the alert it resolves", async () => {
    const alert = await stageInbound("app-alert", mime("App API <api@app.example.org>", "[App API] ALERT: sync job failing"),
      "api@app.example.org", "2026-10-22T08:00:00.000Z");
    await processInbound(alert, fake({ category: "notification", urgency: 2 }).env);
    const resolved = await stageInbound("app-resolved", mime("App API <api@app.example.org>", "[App API] RESOLVED: sync job failing"),
      "api@app.example.org", "2026-10-22T08:20:00.000Z", "app-resolved@example.com");
    const ai = fake({ category: "notification", urgency: 1 });
    await processInbound(resolved, ai.env);

    const rows = await env.DB.prepare("SELECT id, folder FROM messages ORDER BY id").all();
    expect(rows.results).toEqual([{ id: "app-alert", folder: "archive" }, { id: "app-resolved", folder: "archive" }]);
    const details = await env.DB.prepare("SELECT message_id, detail FROM autopilot_actions ORDER BY message_id").all();
    expect(details.results).toEqual([{ message_id: "app-alert", detail: "alert resolved" }, { message_id: "app-resolved", detail: "alert resolved" }]);
    expect(ai.queued).toEqual([]);
  });

  it("leaves people's mail and starred alerts alone", async () => {
    const starred = await stageInbound("kept", mime("Cluster <alerts@ops.example.org>", "Cluster fleet: no host has room"),
      "alerts@ops.example.org", "2026-10-22T08:00:00.000Z");
    await processInbound(starred, fake({ category: "notification", urgency: 2 }).env);
    await env.DB.prepare("UPDATE messages SET starred = 1 WHERE id = 'kept'").run();
    await processInbound(await stageInbound("again", mime("Cluster <alerts@ops.example.org>", "Cluster fleet: no host has room"),
      "alerts@ops.example.org", "2026-10-22T09:00:00.000Z", "again@example.com"), fake({ category: "notification", urgency: 2 }).env);
    const person = await stageInbound("meeting-1", mime("Alex <alex@example.org>", "Meeting"), "alex@example.org",
      "2026-10-22T08:00:00.000Z", "meeting-1@example.com");
    await processInbound(person, fake({ category: "personal" }).env);
    await processInbound(await stageInbound("meeting-2", mime("Alex <alex@example.org>", "Meeting"), "alex@example.org",
      "2026-10-22T09:00:00.000Z", "meeting-2@example.com"), fake({ category: "personal" }).env);
    const rows = await env.DB.prepare("SELECT id, folder FROM messages ORDER BY id").all();
    expect(rows.results.every((row) => row.folder === "inbox")).toBe(true);
  });
});

describe("mailbox listings", () => {
  it("hides spam from the inbox, shows it under spam, and reports the triage", async () => {
    await processInbound(await stageInbound("listed-spam", mime("SEO <seo@example.com>", "Growth for your site")), fake({ spam: 0.95 }).env);
    await processInbound(await stageInbound("listed-ham", mime("Stripe <notifications@stripe.com>", "Activate your account")),
      fake({ category: "notification", urgency: 2 }).env);
    const issued = await issueDeviceApiKey(env as unknown as Env, "autopilot-test", ["mail:read"], [OWNER], "2099-01-01T00:00:00.000Z", "test");
    const list = async (folder: string) => {
      const response = await workerExports.default.fetch(new Request(`https://mail.test/v1/messages?folder=${folder}`,
        { headers: { Authorization: `Bearer ${issued.token}` } }));
      return (await response.json() as { messages: Array<{ subject: string; triage: { category: string; urgency: number } | null }> }).messages;
    };
    expect((await list("inbox")).map((message) => message.subject)).toEqual(["Activate your account"]);
    expect((await list("spam")).map((message) => message.subject)).toEqual(["Growth for your site"]);
    expect((await list("inbox"))[0]?.triage).toMatchObject({ category: "notification", urgency: 2, needsReply: false });
  });
});

describe("reply drafts", () => {
  it("writes in the owner's voice from earlier mail to the same person, signs configured identities, and only once", async () => {
    await stageSent("earlier", EXTERNAL, "t.reed@ext.example.org", "Weekly Notes",
      "Hello Taylor,\n\nPlease find the notes attached.\n\nBest,\nOwner\n\n------------------\nOwner\nExternal Organization\nSIGMARKER");
    await stageReady("colleague", EXTERNAL, "Taylor Reed", "t.reed@ext.example.org", "Weekly Notes",
      "Hi Owner,\nplease send me an updated version by tomorrow 3pm.\n\nBest,\nT. Reed");
    const ai = fake(null);

    expect(await draftReply(ai.env, "colleague")).toBe("drafted");
    const prompt = ai.calls[0]?.input.messages ?? [];
    expect(prompt[0]?.content).toContain("Owner to t.reed@ext.example.org");
    expect(prompt[0]?.content).toContain("Please find the notes attached.");
    // The example is their own text, not the trailing signature.
    expect(prompt[0]?.content).not.toContain("SIGMARKER");
    expect(prompt[1]?.content).toContain("please send me an updated version by tomorrow 3pm");

    const draft = await env.DB.prepare("SELECT identity_address, reply_to_message_id, recipients_json, subject, text_body FROM drafts")
      .first<Record<string, string>>();
    expect(draft).toMatchObject({ identity_address: EXTERNAL, reply_to_message_id: "colleague",
      recipients_json: JSON.stringify(["t.reed@ext.example.org"]), subject: "Re: Weekly Notes" });
    expect(draft?.text_body).toMatch(/^Hello Taylor,[\s\S]*Owner\n\n-{18}\nOwner\nExternal Organization/);

    expect(await draftReply(ai.env, "colleague")).toBe("exists");
    expect(ai.calls.length).toBe(1);
    expect(await actions("colleague")).toEqual(["draft"]);
    expect((await env.DB.prepare("SELECT kind, model FROM ai_runs WHERE kind = 'draft'").first())).toEqual({ kind: "draft", model: "@cf/zai-org/glm-5.3-flash" });

    const [action] = (await env.DB.prepare("SELECT * FROM autopilot_actions WHERE message_id = 'colleague'").all<ActionRow>()).results;
    await undoAction(env as unknown as Env, action!);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM drafts").first<{ count: number }>())?.count).toBe(0);
  });

  it("writes nothing on its own while drafts are off, but drafts when the owner asks", async () => {
    await writeAutopilotSettings(env as unknown as Env, { drafts: false });
    await stageReady("muted", OWNER, "Alex", "alex@example.org", "Tuesday?", "Does Tuesday work?");
    const ai = fake(null, "Hi Alex,\n\nTuesday works.\n\nBest,\nOwner");
    expect(await draftReply(ai.env, "muted")).toBe("skipped");
    expect(ai.calls).toEqual([]);
    expect(await draftReply(ai.env, "muted", { onDemand: true })).toBe("drafted");
    expect(await draftReply(ai.env, "muted", { onDemand: true })).toBe("drafted");
    const drafts = await env.DB.prepare("SELECT text_body FROM drafts WHERE reply_to_message_id = 'muted'").all<{ text_body: string }>();
    // Not a signed identity: no signature appended.
    expect(drafts.results).toEqual([{ text_body: "Hi Alex,\n\nTuesday works.\n\nBest,\nOwner" }, { text_body: "Hi Alex,\n\nTuesday works.\n\nBest,\nOwner" }]);
  });

  it("cleans what a chat model wraps around a reply", () => {
    expect(cleanDraft("```\nSubject: Re: x\n\nHi Ivan,\n\nSure.\n\nBest,\nOwner\n```")).toBe("Hi Ivan,\n\nSure.\n\nBest,\nOwner");
    expect(replySubject("AW: Termin")).toBe("AW: Termin");
    expect(replySubject("Termin")).toBe("Re: Termin");
    expect(ownText("Sounds good!\n\nOn 12.10.2026 at 23:44 Taylor wrote:\n> please")).toBe("Sounds good!");
  });
});

describe("sweep", () => {
  it("triages recent untriaged mail, leaves old mail alone, and stops when the models are down", async () => {
    const now = Date.now();
    await stageReady("recent", OWNER, "Exa", "hello@exa.ai", "What's new", "News", new Date(now - 3_600_000).toISOString());
    await stageReady("old", OWNER, "Exa", "hello@exa.ai", "Old news", "News", new Date(now - 5 * 86_400_000).toISOString());

    expect(await runAutopilotSweep(fake(null).env, { maxMessages: 10, deadlineMs: 10_000 }))
      .toMatchObject({ triaged: 0, stoppedEarly: true });
    expect(await runAutopilotSweep(fake({ category: "newsletter" }).env, { maxMessages: 10, deadlineMs: 10_000 }))
      .toMatchObject({ triaged: 1, actions: 1, stoppedEarly: false });
    const rows = await env.DB.prepare("SELECT id, folder, triaged_at IS NOT NULL AS triaged FROM messages ORDER BY id").all();
    expect(rows.results).toEqual([{ id: "old", folder: "inbox", triaged: 0 }, { id: "recent", folder: "archive", triaged: 1 }]);
  });
});

describe("api", () => {
  it("lists actions, undoes one by the short id from the brief, and keeps settings to keys for the owner's mailbox", async () => {
    const job = await stageInbound("api-news", mime("Exa <hello@exa.ai>", "What's new at Exa"));
    await processInbound(job, fake({ category: "newsletter" }).env);
    const admin = await issueApiKey(env as unknown as Env, "autopilot-admin", ["mail:read", "mail:write"], null, null, "test");
    const device = await issueDeviceApiKey(env as unknown as Env, "autopilot-device", ["mail:read", "mail:write"], [OWNER],
      "2099-01-01T00:00:00.000Z", "test");
    const call = (token: string, method: string, path: string, body?: unknown) => workerExports.default.fetch(new Request(
      `https://mail.test/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) }));

    const status = await (await call(device.token, "GET", "/autopilot")).json() as { settings: { enabled: boolean }; last24h: Record<string, number> };
    expect(status.settings.enabled).toBe(true);
    expect(status.last24h).toEqual({ archive: 1 });

    const log = await (await call(device.token, "GET", "/autopilot/actions")).json() as { actions: Array<{ id: string; action: string; subject: string }> };
    expect(log.actions).toMatchObject([{ action: "archive", subject: "What's new at Exa" }]);
    const undo = await call(device.token, "POST", `/autopilot/actions/${log.actions[0]!.id.slice(0, 8)}/undo`);
    expect(undo.status).toBe(200);
    expect(await env.DB.prepare("SELECT folder, unread FROM messages WHERE id = ?").bind(job.id).first()).toEqual({ folder: "inbox", unread: 1 });
    expect((await call(device.token, "POST", `/autopilot/actions/${log.actions[0]!.id}/undo`)).status).toBe(409);

    const external = await issueDeviceApiKey(env as unknown as Env, "external-device", ["mail:read", "mail:write"], [EXTERNAL],
      "2099-01-01T00:00:00.000Z", "test");
    expect((await call(external.token, "PATCH", "/autopilot", { enabled: false })).status).toBe(403);
    const ownerKey = await issueDeviceApiKey(env as unknown as Env, "owner-device", ["mail:read", "mail:write"],
      [(env as unknown as Env).OWNER_EMAIL], "2099-01-01T00:00:00.000Z", "test");
    expect((await call(ownerKey.token, "PATCH", "/autopilot", { drafts: true })).status).toBe(200);
    expect(await (await call(admin.token, "PATCH", "/autopilot", { enabled: false, dailyCapUsd: 0.25 })).json())
      .toMatchObject({ settings: { enabled: false, dailyCapUsd: 0.25 } });
    const created = await call(admin.token, "POST", "/autopilot/rules", { category: "agent", action: "read", senderMatch: "@agents.example.org" });
    expect(created.status).toBe(201);
    const { rule } = await created.json() as { rule: { id: string } };
    expect((await call(admin.token, "PATCH", `/autopilot/rules/${rule.id}`, { enabled: false })).status).toBe(200);
    expect((await call(admin.token, "DELETE", `/autopilot/rules/${rule.id}`)).status).toBe(200);
    expect((await call(admin.token, "POST", "/autopilot/rules", { category: "spam", action: "archive" })).status).toBe(400);
  });
});

describe("brief", () => {
  it("lists what waits on the owner and what was handled, lands in the inbox once a day, and stays out of the graph", async () => {
    await stageReady("waiting", OWNER, "Alex", "alex@example.org", "Tuesday?", "Does Tuesday 11:30 work?",
      new Date(Date.now() - 3_600_000).toISOString());
    await env.DB.prepare("UPDATE messages SET triage_category = 'personal', triage_needs_reply = 0.9, triage_urgency = 1, triaged_at = ? WHERE id = 'waiting'")
      .bind(new Date().toISOString()).run();
    const job = await stageInbound("filed", mime("Exa <hello@exa.ai>", "What's new at Exa"));
    await processInbound(job, fake({ category: "newsletter" }).env);

    const ai = fake(null, '["Asks whether Tuesday 11:30 works for a call."]');
    const at = new Date("2026-10-24T07:05:00.000Z"); // 07:05 in UTC (OWNER_TIMEZONE)
    const first = await maybeWriteDailyBrief(ai.env, at);
    expect(first.written).toBe(true);
    expect(await maybeWriteDailyBrief(ai.env, at)).toEqual({ written: false, reason: "Already written today" });
    expect(await maybeWriteDailyBrief(ai.env, new Date("2026-10-24T09:00:00.000Z"))).toEqual({ written: false, reason: "Not brief time" });

    const brief = await env.DB.prepare(`SELECT folder, sender_name, subject, text_key, triaged_at IS NOT NULL AS triaged,
      (SELECT COUNT(*) FROM kg_state WHERE message_id = m.id) AS indexed FROM messages m WHERE id = ?`)
      .bind(first.messageId).first<{ folder: string; sender_name: string; subject: string; text_key: string; triaged: number; indexed: number }>();
    expect(brief).toMatchObject({ folder: "inbox", sender_name: "Autopilot", subject: "Brief: 1 waiting on you, 1 handled", triaged: 1, indexed: 0 });
    const text = await (await env.MAIL.get(brief!.text_key))!.text();
    expect(text).toContain("• Alex: Asks whether Tuesday 11:30 works for a call.");
    expect(text).toContain("Archived: 1");
    expect(text).toMatch(/ {2}[0-9a-f-]{8} {2}Exa: What's new at Exa/);
    expect(ai.queued).toEqual([{ kind: "push", messageId: first.messageId }]);
  });

  it("is not written while the brief is off", async () => {
    await writeAutopilotSettings(env as unknown as Env, { brief: false });
    expect(await writeDailyBrief(fake(null).env)).toEqual({ written: false, reason: "The brief is turned off" });
  });
});

async function outboxCount(id: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS count FROM push_notification_outbox WHERE message_id = ?").bind(id)
    .first<{ count: number }>())?.count ?? 0;
}

async function actions(id: string): Promise<string[]> {
  return (await env.DB.prepare("SELECT action FROM autopilot_actions WHERE message_id = ? ORDER BY created_at").bind(id)
    .all<{ action: string }>()).results.map((row) => row.action);
}

function mime(from: string, subject: string): string {
  return [
    `From: ${from}`,
    `To: ${OWNER}`,
    `Subject: ${subject}`,
    `Message-ID: <${subject.replaceAll(/\W+/g, "-")}@example.com>`,
    "",
    "I visited your website and noticed a few issues holding back your ranking.",
    "",
  ].join("\r\n");
}

async function stageInbound(id: string, raw: string, from = "sender@example.com", receivedAt = "2026-09-08T10:00:00.000Z",
  messageId?: string): Promise<InboundJob> {
  const rawKey = `raw/${id}.eml`;
  if (messageId) raw = raw.replace(/^Message-ID: .*$/m, `Message-ID: <${messageId}>`).replace(/^To: /m, `Date: ${new Date(receivedAt).toUTCString()}\r\nTo: `);
  else raw = raw.replace(/^To: /m, `Date: ${new Date(receivedAt).toUTCString()}\r\nTo: `);
  await env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
  await env.DB.prepare(`INSERT INTO messages
    (id, thread_id, direction, folder, sender_address, recipients_json, raw_key, received_at, size, status, identity_address)
    VALUES (?, ?, 'inbound', 'inbox', ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, id, from, JSON.stringify([{ address: OWNER }]), rawKey, receivedAt, raw.length, OWNER).run();
  return { id, rawKey, envelopeFrom: from, envelopeTo: OWNER, receivedAt, size: raw.length };
}

async function stageReady(id: string, identity: string, senderName: string, sender: string, subject: string, text: string,
  receivedAt = "2026-10-12T21:44:00.000Z"): Promise<void> {
  await env.MAIL.put(`body/${id}.txt`, text);
  await env.DB.prepare(`INSERT INTO messages (id, thread_id, direction, folder, subject, sender_name, sender_address, recipients_json,
      preview, text_key, raw_key, received_at, status, identity_address)
    VALUES (?, ?, 'inbound', 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`)
    .bind(id, id, subject, senderName, sender, JSON.stringify([{ address: identity }]), text.slice(0, 240), `body/${id}.txt`,
      `raw/${id}.eml`, receivedAt, identity).run();
}

async function stageSent(id: string, identity: string, to: string, subject: string, text: string): Promise<void> {
  await env.MAIL.put(`body/${id}.txt`, text);
  await env.DB.prepare(`INSERT INTO messages (id, thread_id, direction, folder, subject, sender_name, sender_address, recipients_json,
      preview, text_key, raw_key, received_at, status, identity_address)
    VALUES (?, ?, 'outbound', 'sent', ?, 'Owner', ?, ?, ?, ?, ?, '2026-10-12T17:41:00.000Z', 'ready', ?)`)
    .bind(id, id, subject, identity, JSON.stringify([{ name: "Taylor Reed", address: to }]), text.slice(0, 240),
      `body/${id}.txt`, `raw/${id}.eml`, identity).run();
}
