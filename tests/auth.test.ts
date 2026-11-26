import { describe, expect, it } from "vitest";
import { cookieValue, hasScope } from "../src/worker/auth";

describe("scope authorization", () => {
  it("accepts exact and namespace wildcard grants", () => {
    expect(hasScope(["mail:read"], "mail:read")).toBe(true);
    expect(hasScope(["mail:*"], "mail:send")).toBe(true);
    expect(hasScope(["*"], "keys:write")).toBe(true);
  });

  it("rejects privilege escalation across namespaces", () => {
    expect(hasScope(["mail:read"], "mail:send")).toBe(false);
    expect(hasScope(["mail:*"], "keys:read")).toBe(false);
  });
});

describe("web session cookies", () => {
  it("extracts only the named cookie without exposing adjacent values", () => {
    expect(cookieValue("theme=dark; __Host-lmail-session=secret-token; other=value", "__Host-lmail-session"))
      .toBe("secret-token");
    expect(cookieValue("theme=dark", "__Host-lmail-session")).toBeNull();
  });
});
