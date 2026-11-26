import { describe, expect, it } from "vitest";
import { extractHomepageIconURLs, safeLogoSVG } from "../src/worker/logo-discovery";

describe("high-resolution logo discovery", () => {
  it("finds standard, Apple, and structured homepage icons", () => {
    const html = `<html><head>
      <link rel="icon" type="image/svg+xml" href="/brand/icon.svg">
      <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.example.com/apple.png">
      <meta property="og:logo" content="/brand/logo-1024.png">
      <script type="application/ld+json">{"@type":"Organization","logo":{"url":"/brand/organization.svg"}}</script>
    </head></html>`;
    expect(extractHomepageIconURLs(html, new URL("https://example.com/"))).toEqual(expect.arrayContaining([
      "https://example.com/brand/icon.svg", "https://cdn.example.com/apple.png",
      "https://example.com/brand/logo-1024.png", "https://example.com/brand/organization.svg",
    ]));
  });

  it("allows internal SVG references but rejects active or remote references", () => {
    const internal = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>');
    const remote = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><use href="https://tracker.example/pixel"/></svg>');
    const active = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expect(safeLogoSVG(internal)).not.toBeNull();
    expect(safeLogoSVG(remote)).toBeNull();
    expect(safeLogoSVG(active)).toBeNull();
  });
});
