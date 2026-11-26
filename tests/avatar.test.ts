import { describe, expect, it } from "vitest";
import { avatarColor } from "../src/worker/avatar";

describe("API avatar colors", () => {
  it("returns a stable hex color for the same normalized address", () => {
    expect(avatarColor("Friend@Example.com")).toBe(avatarColor(" friend@example.com "));
    expect(avatarColor("friend@example.com")).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("gives unrelated correspondents distinct colors", () => {
    expect(avatarColor("friend@example.com")).not.toBe(avatarColor("no-reply@signin.aws"));
  });
});
