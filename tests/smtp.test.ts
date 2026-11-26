import { describe, expect, it } from "vitest";
import { submitViaSmtp, type SmtpTransport } from "../src/worker/smtp";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ScriptedSmtpServer implements SmtpTransport {
  readonly written: string[] = [];
  tlsStarted = false;
  private outbox: Uint8Array[] = [encoder.encode("220 mail ESMTP ready\r\n")];
  private waiter: ((chunk: Uint8Array | null) => void) | null = null;
  private inData = false;
  private dataBuffer = "";
  private authState: "none" | "waitUser" | "waitPass" = "none";

  constructor(private authPlainReply = "235 2.7.0 Authentication successful") {}

  read(): Promise<Uint8Array | null> {
    const next = this.outbox.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  write(data: Uint8Array): Promise<void> {
    const text = decoder.decode(data);
    this.written.push(text);
    if (this.inData) {
      this.dataBuffer += text;
      if (this.dataBuffer.endsWith("\r\n.\r\n")) {
        this.inData = false;
        this.push("250 2.0.0 queued as ABCD1234");
      }
      return Promise.resolve();
    }
    const line = text.trim();
    if (this.authState === "waitUser") { this.authState = "waitPass"; this.push("334 UGFzc3dvcmQ6"); }
    else if (this.authState === "waitPass") { this.authState = "none"; this.push("235 2.7.0 Authentication successful"); }
    else if (line.startsWith("EHLO")) this.push("250-smtp.example\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN");
    else if (line === "STARTTLS") this.push("220 2.0.0 Ready to start TLS");
    else if (line.startsWith("AUTH PLAIN")) this.push(this.authPlainReply);
    else if (line === "AUTH LOGIN") { this.authState = "waitUser"; this.push("334 VXNlcm5hbWU6"); }
    else if (line.startsWith("MAIL FROM:")) this.push("250 2.1.0 OK");
    else if (line.startsWith("RCPT TO:")) this.push("250 2.1.5 OK");
    else if (line === "DATA") { this.inData = true; this.push("354 End data with <CR><LF>.<CR><LF>"); }
    else if (line === "QUIT") this.push("221 2.0.0 Bye");
    else this.push("500 unrecognized");
    return Promise.resolve();
  }

  startTls(): Promise<void> {
    this.tlsStarted = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  get dataPayload(): string {
    return this.dataBuffer;
  }

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

describe("SMTP submission", () => {
  it("upgrades to TLS before authenticating and submits dot-stuffed data", async () => {
    const server = new ScriptedSmtpServer();
    const result = await submitViaSmtp({
      host: "smtp.example", port: 587,
      username: "user@example.com", password: "secret",
      from: "user@example.com", recipients: ["target@example.org"],
      raw: "Subject: Test\r\n\r\nHello\r\n.hidden line\r\n",
    }, () => Promise.resolve(server));
    expect(server.tlsStarted).toBe(true);
    const authIndex = server.written.findIndex((line) => line.startsWith("AUTH PLAIN"));
    const tlsIndex = server.written.findIndex((line) => line.trim() === "STARTTLS");
    expect(tlsIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(tlsIndex);
    expect(server.written[authIndex]).toContain(btoa("\0user@example.com\0secret"));
    expect(server.dataPayload).toContain("\r\n..hidden line\r\n");
    expect(server.dataPayload.endsWith("\r\n.\r\n")).toBe(true);
    expect(result.messageId).toContain("queued as ABCD1234");
  });

  it("falls back to AUTH LOGIN when PLAIN is unsupported", async () => {
    const server = new ScriptedSmtpServer("504 5.7.4 Unrecognized authentication type");
    await submitViaSmtp({
      host: "smtp.example", port: 587,
      username: "user@example.com", password: "secret",
      from: "user@example.com", recipients: ["target@example.org"],
      raw: "Subject: Test\r\n\r\nHello\r\n",
    }, () => Promise.resolve(server));
    expect(server.written.some((line) => line.trim() === "AUTH LOGIN")).toBe(true);
    expect(server.written.some((line) => line.trim() === btoa("user@example.com"))).toBe(true);
    expect(server.written.some((line) => line.trim() === btoa("secret"))).toBe(true);
  });

  it("fails when a recipient is rejected", async () => {
    class RejectingServer extends ScriptedSmtpServer {
      write(data: Uint8Array): Promise<void> {
        if (decoder.decode(data).startsWith("RCPT TO:")) return super.write(encoder.encode("UNKNOWN-COMMAND\r\n"));
        return super.write(data);
      }
    }
    await expect(submitViaSmtp({
      host: "smtp.example", port: 587,
      username: "user@example.com", password: "secret",
      from: "user@example.com", recipients: ["blocked@example.org"],
      raw: "Subject: Test\r\n\r\nHello\r\n",
    }, () => Promise.resolve(new RejectingServer()))).rejects.toThrow(/failed with 500/);
  });
});
