import { describe, expect, it } from "vitest";
import { authenticationResultsFromRawHeaders, parseBimiRecord, safeBimiSVG, senderPassedDmarc } from "../src/worker/bimi";

describe("BIMI sender logos", () => {
  it("requires a DMARC pass aligned with the visible From domain", () => {
    const header = "mail.example; dkim=pass header.d=amazon.com; dmarc=pass (p=reject) header.from=amazon.com";
    expect(senderPassedDmarc([header], "amazon.com")).toBe(true);
    expect(senderPassedDmarc([header], "example.com")).toBe(false);
    expect(senderPassedDmarc([header.replace("dmarc=pass", "dmarc=fail")], "amazon.com")).toBe(false);
  });

  it("extracts folded Authentication-Results headers", () => {
    const raw = "From: Shop <orders@amazon.com>\r\nAuthentication-Results: mx.example; dmarc=pass;\r\n\theader.from=amazon.com\r\nSubject: Order\r\n\r\nBody";
    expect(authenticationResultsFromRawHeaders(raw)).toEqual(["mx.example; dmarc=pass; header.from=amazon.com"]);
  });

  it("accepts HTTPS BIMI records with optional mark certificates", () => {
    const valid = parseBimiRecord(["v=BIMI1; l=https://assets.example/logo.svg; a=https://assets.example/mark.pem"]);
    expect(valid?.logo.toString()).toBe("https://assets.example/logo.svg");
    expect(parseBimiRecord(["v=BIMI1; l=https://assets.example/logo.svg"])?.certificate).toBeNull();
    expect(parseBimiRecord(["v=BIMI1; l=http://assets.example/logo.svg; a=https://assets.example/mark.pem"])).toBeNull();
  });

  it("allows Tiny PS artwork and rejects active SVG content", () => {
    const safe = new TextEncoder().encode('<svg baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>');
    const safeFavicon = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>');
    const active = new TextEncoder().encode('<svg baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(safeBimiSVG(safe)).not.toBeNull();
    expect(safeBimiSVG(safeFavicon)).toBeNull();
    expect(safeBimiSVG(safeFavicon, false)).not.toBeNull();
    expect(safeBimiSVG(active)).toBeNull();
  });
});
