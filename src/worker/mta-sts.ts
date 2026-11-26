import type { MiddlewareHandler } from "hono";
import { MTA_STS_POLICY, mtaStsHosts } from "./config";
import type { Env } from "./types";

export const isolateMtaStsHosts: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const isMtaHost = mtaStsHosts(c.env).has(new URL(c.req.url).hostname.toLowerCase());
  if (!isMtaHost) {
    await next();
    return;
  }
  if (c.req.method === "GET" && c.req.path === "/.well-known/mta-sts.txt") {
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
