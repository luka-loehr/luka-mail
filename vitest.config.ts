import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/worker/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-11",
        compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
        d1Databases: ["DB"],
        r2Buckets: ["MAIL"],
        queueProducers: { MAIL_QUEUE: { queueName: "lmail-inbound" } },
        ratelimits: {
          AUTH_RATE_LIMITER: { namespace_id: "test-auth", simple: { limit: 1_000, period: 60 } },
          API_RATE_LIMITER: { namespace_id: "test-api", simple: { limit: 1_000, period: 60 } },
          SEND_RATE_LIMITER: { namespace_id: "test-send", simple: { limit: 1_000, period: 60 } },
          ADMIN_RATE_LIMITER: { namespace_id: "test-admin", simple: { limit: 1_000, period: 60 } },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          APP_NAME: "lmail Test",
          OWNER_EMAIL: "owner@example.com",
          OWNER_NAME: "Owner",
          MAIL_HOST: "mail.example.com",
          WORKER_NAME: "lmail",
          APNS_TOPIC: "com.example.lmail",
          CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
          MANAGED_DOMAINS_JSON: JSON.stringify({
            "example.com": "11111111111111111111111111111111",
            "aws.example.com": "11111111111111111111111111111111",
            "aws.example.org": "22222222222222222222222222222222",
            "aws.example.net": "33333333333333333333333333333333",
          }),
          DMARC_REPORT_ADDRESS: "dmarc@example.com",
          TLS_REPORT_ADDRESS: "tlsrpt@example.com",
          OWNER_PROFILE: "",
          OWNER_STYLE_GUIDE: "",
          IDENTITY_SIGNATURES_JSON: JSON.stringify({
            "ext.example.org": "------------------\nOwner\nExternal Organization",
          }),
          AGENT_SENDER_DOMAINS: "agents.example.org",
          OWNER_TIMEZONE: "UTC",
          API_KEY_PEPPER: "test-api-pepper",
          AUDIT_IP_PEPPER: "test-audit-pepper",
          CLOUDFLARE_API_TOKEN: "test-routing-token",
          DELIVERABILITY_API_TOKEN: "test-deliverability-token",
          AGENT_MODEL: "@cf/zai-org/glm-5.3-flash",
          KG_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          EXTERNAL_MAIL_PASSWORD: "test-external-password",
        },
      },
    })),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    // The workerd pool is slow to start on small machines; 5 s made healthy tests time out.
    testTimeout: 30_000,
    setupFiles: ["./tests/apply-migrations.ts"],
    coverage: { reporter: ["text", "html"] },
  },
});
