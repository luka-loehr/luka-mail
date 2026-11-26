import { describe, expect, it } from "vitest";
import { randomToken, sha256, stableId } from "../src/worker/crypto";

describe("API key primitives", () => {
  it("creates 512-bit URL-safe secrets", () => {
    const first = randomToken(64);
    const second = randomToken(64);
    expect(first).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(second).not.toBe(first);
  });

  it("hashes secrets deterministically without retaining plaintext", async () => {
    expect(await sha256("pepper:secret")).toBe(await sha256("pepper:secret"));
    expect(await sha256("pepper:secret")).not.toBe(await sha256("pepper:other"));
  });

  it("creates stable opaque identifiers", async () => {
    expect(await stableId("message")).toHaveLength(32);
    expect(await stableId("message")).toBe(await stableId("message"));
  });
});
