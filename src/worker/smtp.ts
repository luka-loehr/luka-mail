// Minimal SMTP submission client over Cloudflare TCP sockets: EHLO, STARTTLS,
// AUTH PLAIN (with AUTH LOGIN fallback), one MAIL FROM/RCPT TO/DATA cycle.

export interface SmtpTransport {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  startTls(): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpSubmission {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  recipients: string[];
  raw: string;
}

interface SmtpReply {
  code: number;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_REPLY_LINES = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function connectStartTlsTransport(hostname: string, port: number): Promise<SmtpTransport> {
  const { connect } = await import("cloudflare:sockets");
  let socket = connect({ hostname, port }, { secureTransport: port === 465 ? "on" : "starttls", allowHalfOpen: false });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : value;
    },
    async write(data) {
      await writer.write(data);
    },
    async startTls() {
      if (port === 465) return;
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    },
    async close() {
      await socket.close().catch(() => undefined);
    },
  };
}

export async function submitViaSmtp(input: SmtpSubmission,
  openTransport: (host: string, port: number) => Promise<SmtpTransport> = connectStartTlsTransport): Promise<{ messageId: string }> {
  const transport = await openTransport(input.host, input.port);
  const client = new SmtpClient(transport);
  try {
    await client.expect(220, "greeting");
    await client.command("EHLO lmail.invalid", 250);
    if (input.port !== 465) {
      await client.command("STARTTLS", 220);
      client.prepareTlsUpgrade();
      await transport.startTls();
      await client.command("EHLO lmail.invalid", 250);
    }
    await client.authenticate(input.username, input.password);
    await client.command(`MAIL FROM:<${cleanAddress(input.from)}>`, 250);
    for (const recipient of input.recipients) {
      await client.command(`RCPT TO:<${cleanAddress(recipient)}>`, 250);
    }
    await client.command("DATA", 354);
    const accepted = await client.data(input.raw);
    await client.command("QUIT", 221).catch(() => undefined);
    return { messageId: accepted.text.slice(0, 200) };
  } finally {
    await transport.close();
  }
}

class SmtpClient {
  private buffer = new Uint8Array(0);

  constructor(private readonly transport: SmtpTransport, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async command(line: string, expectedCode: number): Promise<SmtpReply> {
    await this.transport.write(encoder.encode(`${line}\r\n`));
    return this.expect(expectedCode, line.split(" ")[0] ?? line);
  }

  async authenticate(username: string, password: string): Promise<void> {
    const plain = base64(`\0${username}\0${password}`);
    await this.transport.write(encoder.encode(`AUTH PLAIN ${plain}\r\n`));
    const reply = await this.reply();
    if (reply.code === 235) return;
    if (reply.code !== 504 && reply.code !== 535 && reply.code !== 502 && reply.code !== 500) {
      throw new Error(`SMTP AUTH PLAIN failed with ${reply.code}: ${reply.text.slice(0, 200)}`);
    }
    await this.command("AUTH LOGIN", 334);
    await this.command(base64(username), 334);
    await this.command(base64(password), 235);
  }

  async data(raw: string): Promise<SmtpReply> {
    const normalized = raw.replaceAll(/\r?\n/g, "\r\n");
    const stuffed = normalized.split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
    const terminated = stuffed.endsWith("\r\n") ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`;
    await this.transport.write(encoder.encode(terminated));
    return this.expect(250, "DATA body");
  }

  async expect(expectedCode: number, step: string): Promise<SmtpReply> {
    const reply = await this.reply();
    if (reply.code !== expectedCode) {
      throw new Error(`SMTP ${step} failed with ${reply.code}: ${reply.text.slice(0, 200)}`);
    }
    return reply;
  }

  prepareTlsUpgrade(): void {
    if (this.buffer.byteLength > 0) {
      throw new Error("Unexpected pipelined bytes after SMTP STARTTLS");
    }
    this.buffer = new Uint8Array(0);
  }

  // Multi-line replies use "250-..." continuations and end with "250 ...".
  private async reply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      if (lines.length >= MAX_REPLY_LINES) throw new Error("SMTP reply exceeded line limit");
      const line = await this.readLine();
      lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) throw new Error(`Malformed SMTP reply: ${line.slice(0, 120)}`);
      if (match[2] === " ") return { code: Number(match[1]), text: lines.join(" ").slice(0, 500) };
    }
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline !== -1) {
        if (newline > MAX_LINE_BYTES) throw new Error("SMTP reply line exceeded maximum length");
        const end = newline > 0 && this.buffer[newline - 1] === 13 ? newline - 1 : newline;
        const line = decoder.decode(this.buffer.subarray(0, end));
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      if (this.buffer.byteLength > MAX_LINE_BYTES) throw new Error("SMTP reply line exceeded maximum length");
      const chunk = await withTimeout(this.transport.read(), this.timeoutMs, "SMTP read timed out");
      if (chunk === null) throw new Error("SMTP connection closed unexpectedly");
      const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.byteLength);
      this.buffer = merged;
    }
  }
}

function cleanAddress(address: string): string {
  const cleaned = address.replaceAll(/[\r\n<>]/g, "").trim();
  if (!cleaned.includes("@")) throw new Error("SMTP address is invalid");
  return cleaned;
}

function base64(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
