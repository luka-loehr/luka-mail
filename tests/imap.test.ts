import { describe, expect, it } from "vitest";
import { ImapClient, parseInternalDate, quoted, type ImapTransport } from "../src/worker/imap";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ScriptStep {
  match: RegExp;
  reply: (tag: string) => string;
}

class ScriptedTransport implements ImapTransport {
  readonly written: string[] = [];
  private outbox: Uint8Array[] = [];
  private waiter: ((chunk: Uint8Array | null) => void) | null = null;

  constructor(greeting: string, private script: ScriptStep[]) {
    this.outbox.push(encoder.encode(greeting));
  }

  read(): Promise<Uint8Array | null> {
    const next = this.outbox.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  write(data: Uint8Array): Promise<void> {
    const line = decoder.decode(data);
    this.written.push(line);
    const tag = line.split(" ")[0];
    const step = this.script.find((candidate) => candidate.match.test(line));
    const reply = step ? step.reply(tag) : `${tag} BAD unscripted command\r\n`;
    this.push(encoder.encode(reply));
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private push(chunk: Uint8Array): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(chunk);
    } else {
      this.outbox.push(chunk);
    }
  }
}

const RAW_MESSAGE = "From: a@example.com\r\nSubject: Hi\r\n\r\nBody line\r\n";

function scripted(): ScriptedTransport {
  return new ScriptedTransport("* OK IMAP4rev1 ready\r\n", [
    { match: /^A\d+ LOGIN "user@example\.com" "p\\"ss\\\\word"\r\n$/, reply: (tag) => `${tag} OK LOGIN completed\r\n` },
    { match: /^A\d+ LIST /, reply: (tag) => [
      `* LIST (\\HasNoChildren) "/" "INBOX"`,
      `* LIST (\\HasNoChildren \\Sent) "/" "Sent"`,
      `* LIST (\\NoInferiors \\Junk) "/" "Junk"`,
      `* LIST (\\HasNoChildren) "/" "Technick Ag"`,
      `${tag} OK LIST completed`,
      "",
    ].join("\r\n") },
    { match: /^A\d+ EXAMINE "INBOX"/, reply: (tag) => [
      "* 2 EXISTS",
      "* OK [UIDVALIDITY 77] UIDs valid",
      "* OK [UIDNEXT 12] Predicted next UID",
      `${tag} OK [READ-ONLY] EXAMINE completed`,
      "",
    ].join("\r\n") },
    { match: /^A\d+ UID SEARCH UID 6:\*/, reply: (tag) => `* SEARCH 7 11\r\n${tag} OK SEARCH completed\r\n` },
    { match: /^A\d+ UID FETCH 7 /, reply: (tag) =>
      `* 1 FETCH (UID 7 FLAGS (\\Seen \\Flagged) INTERNALDATE "17-Aug-2026 14:03:11 +0200" BODY[] {${RAW_MESSAGE.length}}\r\n${RAW_MESSAGE})\r\n${tag} OK FETCH completed\r\n` },
    { match: /^A\d+ LOGOUT/, reply: (tag) => `* BYE\r\n${tag} OK LOGOUT completed\r\n` },
  ]);
}

describe("IMAP client", () => {
  it("logs in with escaped quoted credentials", async () => {
    const transport = scripted();
    const client = await ImapClient.open(transport);
    await client.login("user@example.com", 'p"ss\\word');
    expect(transport.written[0]).toContain('LOGIN "user@example.com" "p\\"ss\\\\word"');
  });

  it("lists folders with their attributes", async () => {
    const client = await ImapClient.open(scripted());
    await client.login("user@example.com", 'p"ss\\word');
    const folders = await client.listFolders();
    expect(folders.map((folder) => folder.name)).toEqual(["INBOX", "Sent", "Junk", "Technick Ag"]);
    expect(folders[1].attributes).toContain("\\Sent");
  });

  it("reads mailbox state and enumerates only newer UIDs", async () => {
    const client = await ImapClient.open(scripted());
    await client.login("user@example.com", 'p"ss\\word');
    const mailbox = await client.examine("INBOX");
    expect(mailbox).toEqual({ uidValidity: 77, uidNext: 12, exists: 2 });
    expect(await client.uidsAfter(5)).toEqual([7, 11]);
  });

  it("fetches a message with flags, date, and the literal body", async () => {
    const client = await ImapClient.open(scripted());
    await client.login("user@example.com", 'p"ss\\word');
    const message = await client.fetchMessage(7);
    expect(message?.flags).toEqual(["\\Seen", "\\Flagged"]);
    expect(message?.internalDate).toBe("17-Aug-2026 14:03:11 +0200");
    expect(decoder.decode(message?.raw)).toBe(RAW_MESSAGE);
  });

  it("rejects unprintable credentials instead of sending them", () => {
    expect(() => quoted("pass\r\nword")).toThrow();
    expect(() => quoted("pässwort")).toThrow();
  });

  it("parses INTERNALDATE with its timezone", () => {
    const date = parseInternalDate("17-Aug-2026 14:03:11 +0200");
    expect(date?.toISOString()).toBe("2026-08-17T12:03:11.000Z");
    expect(parseInternalDate("nonsense")).toBeNull();
  });
});
