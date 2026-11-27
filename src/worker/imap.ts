// Minimal IMAP4rev1 client over Cloudflare TCP sockets. It implements exactly
// the read-only surface the external-account replicator needs: LOGIN, LIST,
// EXAMINE, UID SEARCH, UID FETCH, and LOGOUT.

export interface ImapTransport {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ImapFolder {
  name: string;
  attributes: string[];
}

export interface ImapMailboxStatus {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface ImapFetchedMessage {
  uid: number;
  flags: string[];
  internalDate: string | null;
  raw: Uint8Array;
}

interface UntaggedResponse {
  line: string;
  literals: Uint8Array[];
}

interface CommandResult {
  status: "OK" | "NO" | "BAD";
  text: string;
  untagged: UntaggedResponse[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_LITERAL_BYTES = 16 * 1024 * 1024;
const MAX_UNTAGGED_RESPONSES = 100_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function connectTlsTransport(hostname: string, port: number): Promise<ImapTransport> {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : value;
    },
    async write(data) {
      await writer.write(data);
    },
    async close() {
      await socket.close().catch(() => undefined);
    },
  };
}

export class ImapClient {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private tagCounter = 0;

  private constructor(private readonly transport: ImapTransport, private readonly timeoutMs: number) {}

  static async open(transport: ImapTransport, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ImapClient> {
    const client = new ImapClient(transport, timeoutMs);
    const greeting = await client.readLine();
    if (!greeting.startsWith("* OK") && !greeting.startsWith("* PREAUTH")) {
      throw new Error(`Unexpected IMAP greeting: ${greeting.slice(0, 120)}`);
    }
    return client;
  }

  async login(username: string, password: string): Promise<void> {
    const result = await this.command(`LOGIN ${quoted(username)} ${quoted(password)}`);
    if (result.status !== "OK") throw new Error(`IMAP login failed: ${result.text.slice(0, 200)}`);
  }

  async listFolders(): Promise<ImapFolder[]> {
    const result = await this.command(`LIST "" "*"`);
    if (result.status !== "OK") throw new Error(`IMAP LIST failed: ${result.text.slice(0, 200)}`);
    const folders: ImapFolder[] = [];
    for (const item of result.untagged) {
      const match = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i.exec(item.line);
      if (!match) continue;
      const attributes = match[1].split(/\s+/).filter(Boolean);
      const rawName = match[2].trim();
      const name = item.literals[0] ? decoder.decode(item.literals[0]) : unquote(rawName);
      if (name) folders.push({ name, attributes });
    }
    return folders;
  }

  async examine(folder: string): Promise<ImapMailboxStatus> {
    const result = await this.command(`EXAMINE ${quoted(folder)}`);
    if (result.status !== "OK") throw new Error(`IMAP EXAMINE ${folder} failed: ${result.text.slice(0, 200)}`);
    let uidValidity = 0;
    let uidNext = 0;
    let exists = 0;
    for (const item of result.untagged) {
      const validity = /\[UIDVALIDITY (\d+)\]/.exec(item.line);
      if (validity) uidValidity = Number(validity[1]);
      const next = /\[UIDNEXT (\d+)\]/.exec(item.line);
      if (next) uidNext = Number(next[1]);
      const existing = /^\* (\d+) EXISTS$/.exec(item.line);
      if (existing) exists = Number(existing[1]);
    }
    if (!uidValidity || !uidNext) throw new Error(`IMAP EXAMINE ${folder} returned no UIDVALIDITY/UIDNEXT`);
    return { uidValidity, uidNext, exists };
  }

  // UIDs strictly greater than afterUid, ascending. The "afterUid+1:*" range
  // always matches at least the newest message, so results are filtered.
  async uidsAfter(afterUid: number): Promise<number[]> {
    const result = await this.command(`UID SEARCH UID ${afterUid + 1}:*`);
    if (result.status !== "OK") throw new Error(`IMAP UID SEARCH failed: ${result.text.slice(0, 200)}`);
    const uids: number[] = [];
    for (const item of result.untagged) {
      const match = /^\* SEARCH((?: \d+)*)\s*$/i.exec(item.line);
      if (!match) continue;
      for (const value of match[1].split(/\s+/).filter(Boolean)) {
        const uid = Number(value);
        if (Number.isSafeInteger(uid) && uid > afterUid) uids.push(uid);
      }
    }
    return uids.sort((left, right) => left - right);
  }

  async fetchMessage(uid: number): Promise<ImapFetchedMessage | null> {
    const result = await this.command(`UID FETCH ${uid} (UID FLAGS INTERNALDATE BODY.PEEK[])`);
    if (result.status !== "OK") throw new Error(`IMAP UID FETCH ${uid} failed: ${result.text.slice(0, 200)}`);
    for (const item of result.untagged) {
      if (!/^\* \d+ FETCH /i.test(item.line)) continue;
      const uidMatch = /\bUID (\d+)/.exec(item.line);
      if (!uidMatch || Number(uidMatch[1]) !== uid) continue;
      const flagsMatch = /\bFLAGS \(([^)]*)\)/.exec(item.line);
      const dateMatch = /\bINTERNALDATE "([^"]*)"/.exec(item.line);
      const raw = item.literals[0];
      if (!raw) return null;
      return {
        uid,
        flags: (flagsMatch?.[1] ?? "").split(/\s+/).filter(Boolean),
        internalDate: dateMatch?.[1] ?? null,
        raw,
      };
    }
    return null;
  }

  async logout(): Promise<void> {
    await this.command("LOGOUT").catch(() => undefined);
    await this.transport.close();
  }

  private async command(command: string): Promise<CommandResult> {
    const tag = `A${String(++this.tagCounter).padStart(3, "0")}`;
    await this.transport.write(encoder.encode(`${tag} ${command}\r\n`));
    const untagged: UntaggedResponse[] = [];
    for (;;) {
      const response = await this.readResponse();
      if (response.line.startsWith(`${tag} `)) {
        const match = /^\S+ (OK|NO|BAD)\b\s*(.*)$/i.exec(response.line);
        if (!match) throw new Error(`Malformed IMAP tagged response: ${response.line.slice(0, 120)}`);
        return { status: match[1].toUpperCase() as CommandResult["status"], text: match[2] ?? "", untagged };
      }
      if (response.line.startsWith("+")) continue;
      if (untagged.length >= MAX_UNTAGGED_RESPONSES) throw new Error("IMAP untagged response count exceeded limit");
      untagged.push(response);
    }
  }

  // One logical response line, joining any {n} literal continuations.
  private async readResponse(): Promise<UntaggedResponse> {
    const literals: Uint8Array[] = [];
    let line = await this.readLine();
    for (;;) {
      const literal = /\{(\d+)(?:\+)?\}$/.exec(line);
      if (!literal) return { line, literals };
      const size = Number(literal[1]);
      if (!Number.isSafeInteger(size) || size > MAX_LITERAL_BYTES) throw new Error(`IMAP literal too large: ${size}`);
      literals.push(await this.readBytes(size));
      line = `${line.slice(0, literal.index)}<literal>${await this.readLine()}`;
    }
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline !== -1) {
        if (newline > MAX_LINE_BYTES) throw new Error("IMAP response line exceeded maximum length");
        const end = newline > 0 && this.buffer[newline - 1] === 13 ? newline - 1 : newline;
        const line = decoder.decode(this.buffer.subarray(0, end));
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      if (this.buffer.byteLength > MAX_LINE_BYTES) throw new Error("IMAP response line exceeded maximum length");
      await this.fill();
    }
  }

  private async readBytes(size: number): Promise<Uint8Array> {
    if (size === 0) return new Uint8Array(0);
    if (this.buffer.byteLength >= size) {
      const bytes = this.buffer.slice(0, size);
      this.buffer = this.buffer.subarray(size);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let collected = 0;
    if (this.buffer.byteLength > 0) {
      chunks.push(this.buffer);
      collected = this.buffer.byteLength;
      this.buffer = new Uint8Array(0);
    }
    while (collected < size) {
      const chunk = await withTimeout(this.transport.read(), this.timeoutMs, "IMAP read timed out");
      if (chunk === null) throw new Error("IMAP connection closed unexpectedly");
      chunks.push(chunk);
      collected += chunk.byteLength;
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const take = Math.min(chunk.byteLength, size - offset);
      output.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take < chunk.byteLength) {
        this.buffer = chunk.subarray(take);
      }
    }
    return output;
  }

  private async fill(): Promise<void> {
    const chunk = await withTimeout(this.transport.read(), this.timeoutMs, "IMAP read timed out");
    if (chunk === null) throw new Error("IMAP connection closed unexpectedly");
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
  }
}

export function quoted(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) throw new Error("IMAP quoted strings must be printable ASCII");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return value;
}

// RFC 3501 INTERNALDATE, e.g. "17-Aug-2026 14:03:11 +0200".
export function parseInternalDate(value: string | null): Date | null {
  if (!value) return null;
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\s*$/.exec(value);
  if (!match) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(match[2].toLowerCase());
  if (month === -1) return null;
  const iso = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}T${match[4]}:${match[5]}:${match[6]}${match[7].slice(0, 3)}:${match[7].slice(3)}`;
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? null : date;
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
