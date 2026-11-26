import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ingestExternalMessage, mapImapFolder, runExternalSync } from "../src/worker/external";
import type { ImapTransport } from "../src/worker/imap";
import type { Env } from "../src/worker/types";

const workerEnv = env as unknown as Env;
const EXTERNAL = "external@ext.example.org";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeMessage {
  uid: number;
  flags: string;
  raw: string;
}

interface FakeMailbox {
  uidValidity: number;
  attributes: string;
  messages: FakeMessage[];
}

class FakeImapServer implements ImapTransport {
  private outbox: Uint8Array[] = [encoder.encode("* OK ready\r\n")];
  private waiter: ((chunk: Uint8Array | null) => void) | null = null;

  constructor(readonly mailboxes: Record<string, FakeMailbox>) {}

  read(): Promise<Uint8Array | null> {
    const next = this.outbox.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  write(data: Uint8Array): Promise<void> {
    const line = decoder.decode(data).trim();
    const tag = line.split(" ")[0];
    const command = line.slice(tag.length + 1);
    if (command.startsWith("LOGIN ")) this.push(`${tag} OK LOGIN completed`);
    else if (command.startsWith("LIST ")) {
      const entries = Object.entries(this.mailboxes)
        .map(([name, mailbox]) => `* LIST (${mailbox.attributes}) "/" "${name}"`);
      this.push([...entries, `${tag} OK LIST completed`].join("\r\n"));
    } else if (command.startsWith("EXAMINE ")) {
      const name = command.slice("EXAMINE ".length).replaceAll('"', "");
      const mailbox = this.mailboxes[name];
      if (!mailbox) { this.push(`${tag} NO no such mailbox`); return Promise.resolve(); }
      const uidNext = Math.max(0, ...mailbox.messages.map((message) => message.uid)) + 1;
      this.push([
        `* ${mailbox.messages.length} EXISTS`,
        `* OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid`,
        `* OK [UIDNEXT ${uidNext}] Predicted next UID`,
        `${tag} OK [READ-ONLY] EXAMINE completed`,
      ].join("\r\n"));
      this.selected = name;
    } else if (command.startsWith("UID SEARCH UID ")) {
      const start = Number(/UID (\d+):\*/.exec(command)?.[1] ?? "1");
      const mailbox = this.mailboxes[this.selected];
      const uids = mailbox.messages.map((message) => message.uid).filter((uid) => uid >= start);
      const newest = Math.max(0, ...mailbox.messages.map((message) => message.uid));
      const results = uids.length ? uids : (mailbox.messages.length ? [newest] : []);
      this.push(`* SEARCH ${results.join(" ")}\r\n${tag} OK SEARCH completed`);
    } else if (command.startsWith("UID FETCH ")) {
      const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
      const message = this.mailboxes[this.selected].messages.find((candidate) => candidate.uid === uid);
      if (!message) { this.push(`${tag} OK FETCH completed`); return Promise.resolve(); }
      this.push(`* 1 FETCH (UID ${message.uid} FLAGS (${message.flags}) INTERNALDATE "17-Aug-2026 10:00:00 +0200" BODY[] {${message.raw.length}}\r\n${message.raw})\r\n${tag} OK FETCH completed`);
    } else if (command.startsWith("LOGOUT")) this.push(`* BYE\r\n${tag} OK LOGOUT completed`);
    else this.push(`${tag} BAD unscripted`);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private selected = "INBOX";

  private push(reply: string): void {
    const chunk = encoder.encode(`${reply}\r\n`);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(chunk);
    } else {
      this.outbox.push(chunk);
    }
  }
}

function rawMail(subject: string, options: { messageId?: string; from?: string } = {}): string {
  return [
    `From: Colleague Example <${options.from ?? "colleague@ext.example.org"}>`,
    `To: ${EXTERNAL}`,
    `Subject: ${subject}`,
    "Date: Mon, 17 Aug 2026 10:00:00 +0200",
    `Message-ID: <${options.messageId ?? `${subject.replaceAll(/\s+/g, "-")}@imap.test`}>`,
    "",
    `Inhalt zu ${subject}`,
    "",
  ].join("\r\n");
}

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare("DELETE FROM attachments"),
    workerEnv.DB.prepare("DELETE FROM messages"),
    workerEnv.DB.prepare("DELETE FROM push_notification_outbox"),
    workerEnv.DB.prepare("DELETE FROM external_sync_state"),
  ]);
});

describe("external message ingestion", () => {
  it("stores an unseen inbox message as a ready inbound row with push retained", async () => {
    const stored = await ingestExternalMessage(workerEnv, {
      identity: EXTERNAL,
      localFolder: "inbox",
      externalFolder: null,
      raw: encoder.encode(rawMail("Elternabend")),
      seen: false,
      flagged: false,
      fallbackReceivedAt: new Date().toISOString(),
      suppressPush: false,
    });
    expect(stored).toBe(true);
    const row = await workerEnv.DB.prepare(
      "SELECT direction, folder, unread, status, subject, identity_address FROM messages").first<Record<string, unknown>>();
    expect(row).toMatchObject({ direction: "inbound", folder: "inbox", unread: 1, status: "ready",
      subject: "Elternabend", identity_address: EXTERNAL });
    const outbox = await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM push_notification_outbox").first<{ count: number }>();
    expect(outbox?.count).toBe(1);
    const change = await workerEnv.DB.prepare(
      "SELECT operation FROM mailbox_changes WHERE identity_address = ? ORDER BY revision DESC LIMIT 1")
      .bind(EXTERNAL).first<{ operation: string }>();
    expect(change?.operation).toBe("upsert");
  });

  it("suppresses push during backfill in the same transaction", async () => {
    await ingestExternalMessage(workerEnv, {
      identity: EXTERNAL, localFolder: "inbox", externalFolder: null,
      raw: encoder.encode(rawMail("Historisch")), seen: false, flagged: false,
      fallbackReceivedAt: new Date().toISOString(), suppressPush: true,
    });
    const outbox = await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM push_notification_outbox").first<{ count: number }>();
    expect(outbox?.count).toBe(0);
  });

  it("replicates seen sent mail as read outbound rows and keeps the origin folder name", async () => {
    await ingestExternalMessage(workerEnv, {
      identity: EXTERNAL, localFolder: "sent", externalFolder: null,
      raw: encoder.encode(rawMail("Antwort", { from: EXTERNAL })), seen: true, flagged: false,
      fallbackReceivedAt: new Date().toISOString(), suppressPush: true,
    });
    await ingestExternalMessage(workerEnv, {
      identity: EXTERNAL, localFolder: "archive", externalFolder: "Technick Ag",
      raw: encoder.encode(rawMail("AG Termin")), seen: true, flagged: true,
      fallbackReceivedAt: new Date().toISOString(), suppressPush: true,
    });
    const sent = await workerEnv.DB.prepare("SELECT direction, unread FROM messages WHERE folder = 'sent'").first<Record<string, unknown>>();
    expect(sent).toMatchObject({ direction: "outbound", unread: 0 });
    const archived = await workerEnv.DB.prepare("SELECT external_folder, starred FROM messages WHERE folder = 'archive'").first<Record<string, unknown>>();
    expect(archived).toMatchObject({ external_folder: "Technick Ag", starred: 1 });
  });

  it("deduplicates by content digest and by Message-ID", async () => {
    const base = {
      identity: EXTERNAL, localFolder: "inbox" as const, externalFolder: null,
      seen: false, flagged: false, fallbackReceivedAt: new Date().toISOString(), suppressPush: true,
    };
    expect(await ingestExternalMessage(workerEnv, { ...base, raw: encoder.encode(rawMail("Doppelt", { messageId: "same@imap.test" })) })).toBe(true);
    expect(await ingestExternalMessage(workerEnv, { ...base, raw: encoder.encode(rawMail("Doppelt", { messageId: "same@imap.test" })) })).toBe(false);
    expect(await ingestExternalMessage(workerEnv, { ...base, raw: encoder.encode(rawMail("Anders formatiert", { messageId: "same@imap.test" })) })).toBe(false);
    const count = await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM messages").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});

describe("external account sync", () => {
  it("maps IMAP folders onto the local folder set", () => {
    expect(mapImapFolder({ name: "INBOX", attributes: ["\\HasNoChildren"] })).toBe("inbox");
    expect(mapImapFolder({ name: "Sent", attributes: ["\\Sent"] })).toBe("sent");
    expect(mapImapFolder({ name: "Trash", attributes: ["\\Trash"] })).toBe("trash");
    expect(mapImapFolder({ name: "Junk", attributes: ["\\Junk"] })).toBeNull();
    expect(mapImapFolder({ name: "Drafts", attributes: ["\\Drafts"] })).toBeNull();
    expect(mapImapFolder({ name: "Technick Ag", attributes: [] })).toBe("archive");
  });

  it("backfills, then syncs incrementally with push for new inbox mail only", async () => {
    const mailboxes: Record<string, FakeMailbox> = {
      INBOX: { uidValidity: 7, attributes: "\\HasNoChildren", messages: [
        { uid: 1, flags: "\\Seen", raw: rawMail("Erste") },
        { uid: 2, flags: "", raw: rawMail("Zweite") },
      ] },
      Sent: { uidValidity: 9, attributes: "\\Sent", messages: [
        { uid: 4, flags: "\\Seen", raw: rawMail("Gesendet", { from: EXTERNAL }) },
      ] },
      Junk: { uidValidity: 3, attributes: "\\Junk", messages: [{ uid: 1, flags: "", raw: rawMail("Spam") }] },
    };
    const openImap = () => Promise.resolve(new FakeImapServer(mailboxes));

    const first = await runExternalSync(workerEnv, { maxMessages: 50, openImap });
    expect(first.done).toBe(true);
    expect(first.syncedMessages).toBe(3);
    const counts = await workerEnv.DB.prepare(
      "SELECT folder, COUNT(*) AS count FROM messages GROUP BY folder ORDER BY folder").all<{ folder: string; count: number }>();
    expect(counts.results).toEqual([{ folder: "inbox", count: 2 }, { folder: "sent", count: 1 }]);
    const junkState = await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM external_sync_state WHERE imap_folder = 'Junk'").first<{ count: number }>();
    expect(junkState?.count).toBe(0);
    const backfillOutbox = await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM push_notification_outbox").first<{ count: number }>();
    expect(backfillOutbox?.count).toBe(0);

    const second = await runExternalSync(workerEnv, { maxMessages: 50, openImap });
    expect(second.syncedMessages).toBe(0);
    expect(second.done).toBe(true);

    mailboxes.INBOX.messages.push({ uid: 5, flags: "", raw: rawMail("Neu eingetroffen") });
    const third = await runExternalSync(workerEnv, { maxMessages: 50, openImap });
    expect(third.syncedMessages).toBe(1);
    const outbox = await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM push_notification_outbox").first<{ count: number }>();
    expect(outbox?.count).toBe(1);
    const state = await workerEnv.DB.prepare(
      "SELECT last_uid, backfill_done FROM external_sync_state WHERE imap_folder = 'INBOX'").first<{ last_uid: number; backfill_done: number }>();
    expect(state).toMatchObject({ last_uid: 5, backfill_done: 1 });
  });

  it("resets the cursor when UIDVALIDITY changes without duplicating messages", async () => {
    const mailboxes: Record<string, FakeMailbox> = {
      INBOX: { uidValidity: 7, attributes: "", messages: [{ uid: 1, flags: "\\Seen", raw: rawMail("Stabil") }] },
    };
    const openImap = () => Promise.resolve(new FakeImapServer(mailboxes));
    await runExternalSync(workerEnv, { maxMessages: 50, openImap });
    mailboxes.INBOX.uidValidity = 8;
    mailboxes.INBOX.messages = [{ uid: 100, flags: "\\Seen", raw: rawMail("Stabil") }];
    const report = await runExternalSync(workerEnv, { maxMessages: 50, openImap });
    expect(report.accounts[0].ok).toBe(true);
    const count = await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM messages").first<{ count: number }>();
    expect(count?.count).toBe(1);
    const state = await workerEnv.DB.prepare(
      "SELECT uidvalidity, last_uid FROM external_sync_state WHERE imap_folder = 'INBOX'").first<{ uidvalidity: number; last_uid: number }>();
    expect(state).toMatchObject({ uidvalidity: 8, last_uid: 100 });
  });
});
