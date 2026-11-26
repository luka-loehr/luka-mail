import { describe, expect, it } from "vitest";
import { MTA_STS_POLICY } from "../src/worker/config";
import { aggregateEvents } from "../src/worker/deliverability";

describe("deliverability", () => {
  it("publishes an enforce MTA-STS policy for every Cloudflare MX", () => {
    expect(MTA_STS_POLICY).toContain("version: STSv1\nmode: enforce\n");
    expect(MTA_STS_POLICY.match(/^mx:/gm)).toHaveLength(3);
    expect(MTA_STS_POLICY).toContain("max_age: 604800\n");
  });

  it("does not classify Cloudflare's none auth telemetry as a failure", () => {
    const report = aggregateEvents([{
      datetime: "2026-08-08T10:00:00Z", from: "owner@example.com", to: "test@example.org",
      status: "delivered", eventType: "delivery", sendingDomain: "example.com", messageId: "one",
      errorCause: null, errorDetail: null, dkim: "none", dmarc: "none", spf: "none",
      isSpam: 0, spamScore: 1, spamThreshold: 5,
    }]);
    expect(report.authenticationFailures).toEqual([]);
    expect(report.deliveryRate).toBe(1);
  });

  it("reports real auth failures and complaints", () => {
    const report = aggregateEvents([{
      datetime: "2026-08-08T10:00:00Z", from: "owner@example.com", to: "test@example.org",
      status: "rejected", eventType: "complaint", sendingDomain: "example.com", messageId: "two",
      errorCause: "feedback loop complaint", errorDetail: null, dkim: "fail", dmarc: "fail", spf: "fail",
      isSpam: 1, spamScore: 7, spamThreshold: 5,
    }]);
    expect(report.authenticationFailures).toHaveLength(1);
    expect(report.complaints).toBe(1);
    expect(report.reputationSignals.spamSignals).toBe(1);
  });
});
