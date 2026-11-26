import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { activityLabel, buildAgentTools, runMailAgentStream, sourcesFrom, type AgentContext } from "../src/worker/agent";
import { ingestExternalMessage } from "../src/worker/external";
import type { Env } from "../src/worker/types";

const workerEnv = env as unknown as Env;
const OWNER = "owner@example.com";
const EXTERNAL = "external@ext.example.org";
const encoder = new TextEncoder();
const callOptions: ToolExecutionOptions<unknown> = { toolCallId: "test-call", messages: [], context: undefined };

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    env: workerEnv,
    principal: { keyId: "agent-key", name: "agent", scopes: ["mail:read", "mail:write"], allowedIdentities: [EXTERNAL] },
    ...overrides,
  };
}

async function seedMessage(subject: string, unread = true): Promise<void> {
  const raw = [
    "From: Colleague <colleague@ext.example.org>",
    `To: ${EXTERNAL}`,
    `Subject: ${subject}`,
    "Date: Mon, 17 Aug 2026 10:00:00 +0200",
    `Message-ID: <${subject.replaceAll(/\s+/g, "-")}@imap.test>`,
    "",
    `Details zu ${subject}.`,
    "",
  ].join("\r\n");
  await ingestExternalMessage(workerEnv, {
    identity: EXTERNAL, localFolder: "inbox", externalFolder: null,
    raw: encoder.encode(raw), seen: !unread, flagged: false,
    fallbackReceivedAt: new Date().toISOString(), suppressPush: true,
  });
}

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare("DELETE FROM attachments"),
    workerEnv.DB.prepare("DELETE FROM messages"),
    workerEnv.DB.prepare("DELETE FROM push_notification_outbox"),
    workerEnv.DB.prepare("DELETE FROM contacts"),
  ]);
});

describe("agent tools", () => {
  it("lists and searches messages within the identity policy", async () => {
    await seedMessage("Mathe Klassenarbeit");
    await seedMessage("Ausflug Schwarzwald", false);
    const tools = buildAgentTools(context());
    const all = await tools.list_messages.execute!({ folder: "inbox", unreadOnly: false, limit: 10 }, callOptions) as {
      messages: Array<{ subject: string; unread: boolean }>;
    };
    expect(all.messages.map((message) => message.subject).sort()).toEqual(["Ausflug Schwarzwald", "Mathe Klassenarbeit"]);
    const unread = await tools.list_messages.execute!({ folder: "inbox", unreadOnly: true, limit: 10 }, callOptions) as {
      messages: Array<{ subject: string }>;
    };
    expect(unread.messages.map((message) => message.subject)).toEqual(["Mathe Klassenarbeit"]);
    const searched = await tools.list_messages.execute!({ folder: "all", query: "Schwarzwald", unreadOnly: false, limit: 10 }, callOptions) as {
      messages: Array<{ subject: string }>;
    };
    expect(searched.messages.map((message) => message.subject)).toEqual(["Ausflug Schwarzwald"]);
  });

  it("refuses identities outside the credential policy", async () => {
    const tools = buildAgentTools(context());
    const result = await tools.list_messages.execute!({ identity: OWNER, folder: "inbox", unreadOnly: false, limit: 5 }, callOptions);
    expect(result).toMatchObject({ error: expect.stringContaining("access policy") as unknown });
  });

  it("reads a message body from object storage", async () => {
    await seedMessage("Elternbrief");
    const tools = buildAgentTools(context());
    const listed = await tools.list_messages.execute!({ folder: "inbox", unreadOnly: false, limit: 1 }, callOptions) as {
      messages: Array<{ id: string }>;
    };
    const message = await tools.read_message.execute!({ id: listed.messages[0].id }, callOptions) as { subject: string; body: string };
    expect(message.subject).toBe("Elternbrief");
    expect(message.body).toContain("Details zu Elternbrief");
  });

  it("enforces scopes on mutations and has no way to send", async () => {
    await seedMessage("Zu archivieren");
    const readOnly = buildAgentTools(context({
      principal: { keyId: "ro", name: "ro", scopes: ["mail:read"], allowedIdentities: [EXTERNAL] },
    }));
    const listed = await readOnly.list_messages.execute!({ folder: "inbox", unreadOnly: false, limit: 1 }, callOptions) as {
      messages: Array<{ id: string }>;
    };
    const denied = await readOnly.update_message.execute!({ id: listed.messages[0].id, folder: "archive" }, callOptions);
    expect(denied).toMatchObject({ error: expect.stringContaining("mail:write") as unknown });

    const writable = buildAgentTools(context());
    const updated = await writable.update_message.execute!({ id: listed.messages[0].id, folder: "archive", unread: false }, callOptions);
    expect(updated).toEqual({ updated: true });
    const row = await workerEnv.DB.prepare("SELECT folder, unread FROM messages WHERE id = ?")
      .bind(listed.messages[0].id).first<{ folder: string; unread: number }>();
    expect(row).toEqual({ folder: "archive", unread: 0 });

    expect(Object.keys(writable).some((name) => name.includes("send"))).toBe(false);
  });

  it("proposes an email from the replied-to mailbox, signed with its configured signature", async () => {
    await seedMessage("Vokabelliste");
    const tools = buildAgentTools(context());
    const listed = await tools.list_messages.execute!({ folder: "inbox", unreadOnly: false, limit: 1 }, callOptions) as {
      messages: Array<{ id: string }>;
    };
    const proposed = await tools.propose_email.execute!({
      from: OWNER, to: ["Colleague@Ext.Example.Org"], cc: [], subject: "Re: Vokabelliste",
      body: "Hello,\n\nSounds good.\n\nBest,\nOwner", replyToMessageId: listed.messages[0]!.id,
    }, callOptions) as { draft: { from: string; to: string[]; body: string; replyToMessageId: string } };
    expect(proposed.draft).toMatchObject({ from: EXTERNAL, to: ["colleague@ext.example.org"], replyToMessageId: listed.messages[0]!.id });
    expect(proposed.draft.body).toMatch(/Owner\n\n-{18}\nOwner\nExternal Organization/);

    const outside = await tools.propose_email.execute!({ from: OWNER, to: ["a@example.org"], cc: [], subject: "x", body: "y" },
      callOptions);
    expect(outside).toMatchObject({ error: expect.stringContaining("outside") as unknown });
  });

  it("labels what the agent does in words", () => {
    expect(activityLabel("semantic_search", { query: "Acme Club" })).toBe("Searched mail for “Acme Club”");
    expect(activityLabel("list_messages", { folder: "inbox", unreadOnly: true })).toBe("Listed unread mail in inbox");
    expect(activityLabel("propose_email", { revisesDraftId: "x" })).toBe("Revised the email");
    expect(sourcesFrom("read_message", { id: "m1", subject: "Hi", from: "A <a@x.org>", receivedAt: "2026-10-01", identity: EXTERNAL }))
      .toEqual([{ id: "m1", subject: "Hi", from: "A <a@x.org>", receivedAt: "2026-10-01", identity: EXTERNAL, read: true }]);
  });

  it("streams reasoning, answer text, and usage as NDJSON events", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "Prüfe das Postfach." },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Alles " },
          { type: "text-delta", id: "t1", delta: "erledigt." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 8, text: 8, reasoning: 0 },
          } },
        ]),
      }),
    });
    const response = await runMailAgentStream(workerEnv, context().principal,
      { prompt: "status?", maxSteps: 4 }, model);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.type === "reasoning" && String(event.text).includes("Prüfe"))).toBe(true);
    expect(events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("Alles erledigt.");
    const finish = events.find((event) => event.type === "finish") as { usage: { inputTokens: number; outputTokens: number } };
    expect(finish.usage.inputTokens).toBe(120);
    expect(finish.usage.outputTokens).toBe(8);
  });

  it("filters by triage, sender and date, and reads whole threads and attachments", async () => {
    const raw = [
      "From: Taylor Reed <t.reed@ext.example.org>", `To: ${EXTERNAL}`, "Subject: Project Notes",
      "Date: Mon, 12 Oct 2026 21:44:00 +0200", "Message-ID: <notes@imap.test>", "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain; charset=utf-8", "",
      "Please review before 3pm tomorrow.", "--b", 'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"', "", "three main sections", "--b--", "",
    ].join("\r\n");
    await ingestExternalMessage(workerEnv, { identity: EXTERNAL, localFolder: "inbox", externalFolder: null, raw: encoder.encode(raw),
      seen: false, flagged: false, fallbackReceivedAt: new Date().toISOString(), suppressPush: true });
    await seedMessage("Older Mail");
    await workerEnv.DB.prepare("UPDATE messages SET triage_category = 'school', triage_needs_reply = 0.9, triage_urgency = 2 WHERE subject = 'Project Notes'").run();
    const tools = buildAgentTools(context());

    const waiting = await tools.list_messages.execute!({ folder: "all", needsReply: true, unreadOnly: false, limit: 10 }, callOptions) as {
      messages: Array<{ id: string; subject: string; needsReply: boolean; category: string; urgency: number; hasAttachments: boolean }>;
    };
    expect(waiting.messages).toMatchObject([{ subject: "Project Notes", needsReply: true, category: "school", urgency: 2, hasAttachments: true }]);
    const fromReed = await tools.list_messages.execute!({ folder: "inbox", from: "reed", unreadOnly: false, limit: 10 }, callOptions) as { messages: unknown[] };
    expect(fromReed.messages).toHaveLength(1);
    const recent = await tools.list_messages.execute!({ folder: "inbox", since: "2026-10-01", unreadOnly: false, limit: 10 }, callOptions) as {
      messages: Array<{ subject: string }> };
    expect(recent.messages.map((message) => message.subject)).toEqual(["Project Notes"]);

    const message = await tools.read_message.execute!({ id: waiting.messages[0]!.id }, callOptions) as { attachments: Array<{ id: string; filename: string }> };
    expect(message.attachments).toMatchObject([{ filename: "notes.txt" }]);
    const attachment = await tools.read_attachment.execute!({ attachmentId: message.attachments[0]!.id }, callOptions) as { text: string };
    expect(attachment.text).toContain("three main sections");
    const thread = await tools.read_thread.execute!({ messageId: waiting.messages[0]!.id }, callOptions) as { messages: Array<{ body: string }> };
    expect(thread.messages[0]!.body).toContain("Please review before 3pm tomorrow");
    expect(sourcesFrom("read_thread", thread)).toMatchObject([{ id: waiting.messages[0]!.id, read: true }]);
  });

  it("saves contacts, lists mailboxes, and reads and undoes what the autopilot did", async () => {
    await seedMessage("Newsletter");
    const tools = buildAgentTools(context());
    expect(await tools.save_contact.execute!({ identity: EXTERNAL, address: "Max@Weber.example", name: "Max Weber" }, callOptions))
      .toMatchObject({ saved: true, address: "max@weber.example" });
    expect(await workerEnv.DB.prepare("SELECT display_name, source FROM contacts WHERE identity_address = ? AND address = 'max@weber.example'")
      .bind(EXTERNAL).first()).toEqual({ display_name: "Max Weber", source: "manual" });
    expect(await tools.save_contact.execute!({ identity: OWNER, address: "a@b.example", name: "" }, callOptions))
      .toMatchObject({ error: expect.stringContaining("outside") as unknown });

    const identities = await tools.list_identities.execute!({}, callOptions) as { identities: Array<{ address: string; kind: string }> };
    expect(identities.identities).toMatchObject([{ address: EXTERNAL, kind: expect.stringContaining("external") as unknown }]);

    const id = (await workerEnv.DB.prepare("SELECT id FROM messages WHERE subject = 'Newsletter'").first<{ id: string }>())!.id;
    await workerEnv.DB.batch([
      workerEnv.DB.prepare("UPDATE messages SET folder = 'archive', unread = 0 WHERE id = ?").bind(id),
      workerEnv.DB.prepare(`INSERT INTO autopilot_actions (id, message_id, rule_id, action, detail, previous_folder, previous_unread, previous_starred, previous_spam)
        VALUES ('act-1', ?, 'default-newsletter', 'archive', 'newsletter 93%', 'inbox', 1, 0, 0)`).bind(id),
    ]);
    const log = await tools.autopilot_log.execute!({ limit: 5 }, callOptions) as { actions: Array<{ id: string; subject: string }>; rules: unknown[] };
    expect(log.actions).toMatchObject([{ id: "act-1", subject: "Newsletter" }]);
    expect(log.rules.length).toBeGreaterThan(0);
    expect(await tools.undo_autopilot_action.execute!({ id: "act-1" }, callOptions)).toMatchObject({ undone: true });
    expect(await workerEnv.DB.prepare("SELECT folder, unread FROM messages WHERE id = ?").bind(id).first()).toEqual({ folder: "inbox", unread: 1 });

    expect(await tools.update_message.execute!({ id, spam: true }, callOptions)).toEqual({ updated: true });
    expect(await workerEnv.DB.prepare("SELECT spam FROM messages WHERE id = ?").bind(id).first()).toEqual({ spam: 1 });
  });

  it("summarizes mailbox counts", async () => {
    await seedMessage("Ungelesen eins");
    const tools = buildAgentTools(context());
    const summary = await tools.mailbox_summary.execute!({}, callOptions) as {
      mailboxes: Array<{ identity_address: string; inbox: number; unread: number }>;
    };
    const external = summary.mailboxes.find((mailbox) => mailbox.identity_address === EXTERNAL);
    expect(external).toMatchObject({ inbox: 1, unread: 1 });
  });
});
