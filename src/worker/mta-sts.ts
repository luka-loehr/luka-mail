import type { MiddlewareHandler } from "hono";
import { MTA_STS_POLICY, mtaStsHosts } from "./config";
import type { Env } from "./types";

export const isolateMtaStsHosts: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const hostname = new URL(c.req.url).hostname.toLowerCase();
  if (!hostname.startsWith("mta-sts.")) {
    await next();
    return;
  }
  const domain = hostname.slice("mta-sts.".length);
  let managed = mtaStsHosts(c.env).has(hostname);
  if (!managed && domain) {
    const row = await c.env.DB.prepare("SELECT 1 AS ok FROM managed_domains WHERE domain = ? LIMIT 1")
      .bind(domain).first<{ ok: number }>().catch(() => null);
    managed = Boolean(row?.ok);
  }
  if (managed && c.req.method === "GET" && c.req.path === "/.well-known/mta-sts.txt") {
    return c.text(MTA_STS_POLICY, 200, {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8",
    });
  }
  return c.text("Not found\n", 404, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
};
