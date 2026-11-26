import { describe, expect, it } from "vitest";
import { buildMime } from "../src/worker/mime";

describe("buildMime", () => {
  it("builds an RFC-style multipart message without exposing Bcc", () => {
    const { raw, messageId } = buildMime("owner@example.com", {
      to: ["friend@example.org"], cc: [], bcc: ["hidden@example.org"], subject: "Grüße aus München",
      from: "owner@example.com",
      text: "Hallo\nWelt", attachments: [{ filename: "note.txt", contentType: "text/plain", data: btoa("secret") }],
    });
    expect(raw).toContain("From: owner@example.com");
    expect(raw).toContain("To: friend@example.org");
    expect(raw).not.toContain("hidden@example.org");
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("Content-Disposition: attachment");
    expect(raw).toContain("=?UTF-8?B?");
    expect(messageId).toMatch(/^<.+@example\.com>$/);
  });

  it("strips newline injection from headers", () => {
    const { raw } = buildMime("owner@example.com", {
      to: ["ok@example.org\nBcc: bad@example.org"], cc: [], bcc: [], subject: "Hello\r\nBcc: bad@example.org",
      from: "owner@example.com",
      text: "Safe", attachments: [],
    });
    expect(raw).not.toContain("\r\nBcc: bad@example.org");
  });

  it("neutralizes quoted attachment parameter injection", () => {
    const { raw } = buildMime("owner@example.com", {
      to: ["ok@example.org"], cc: [], bcc: [], subject: "Safe", from: "owner@example.com",
      text: "Safe", attachments: [{ filename: "x\"; bad=\"yes.txt", contentType: "text/plain", data: btoa("safe") }],
    });
    expect(raw).not.toContain('filename="x"; bad="yes.txt"');
    expect(raw).toContain('filename="x_; bad=_yes.txt"');
  });

  it("encodes the configured sender display name in From", () => {
    const { raw } = buildMime("owner@example.com", {
      from: "owner@example.com", fromName: "Jörg Müller", to: ["friend@example.org"], cc: [], bcc: [],
      subject: "Hello", text: "Hello", attachments: [],
    });
    expect(raw).toContain("From: =?UTF-8?B?SsO2cmcgTcO8bGxlcg==?= <owner@example.com>");
  });
});
