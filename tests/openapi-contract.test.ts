import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import openApiSpec from "../openapi/openapi.json";
import { app } from "../src/worker/index";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function honoToOpenApiPath(path: string): string {
  return path.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

describe("OpenAPI 3.1 contract parity", () => {
  it("matches every registered Hono route and method 1-to-1", () => {
    const actualRoutes = new Set<string>();
    for (const route of app.routes) {
      if (!HTTP_METHODS.has(route.method)) continue;
      if (route.path.includes("*")) continue;
      actualRoutes.add(`${route.method} ${honoToOpenApiPath(route.path)}`);
    }
    // Served directly by isolateMtaStsHosts middleware on mta-sts.* hosts.
    actualRoutes.add("GET /.well-known/mta-sts.txt");

    const declaredRoutes = new Set<string>();
    for (const [routePath, methods] of Object.entries(openApiSpec.paths)) {
      for (const method of Object.keys(methods)) {
        const upper = method.toUpperCase();
        if (HTTP_METHODS.has(upper)) {
          declaredRoutes.add(`${upper} ${routePath}`);
        }
      }
    }

    const undocumented = [...actualRoutes].filter((item) => !declaredRoutes.has(item)).sort();
    const ghosts = [...declaredRoutes].filter((item) => !actualRoutes.has(item)).sort();
    expect(undocumented, "Worker routes missing from openapi/openapi.json").toEqual([]);
    expect(ghosts, "Ghost routes in openapi/openapi.json missing from Worker").toEqual([]);
  });

  it("serves the canonical OpenAPI 3.1.0 specification at GET /openapi.json with security headers", async () => {
    const response = await workerExports.default.fetch(new Request("https://mail.example.com/openapi.json"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.json();
    expect(body).toEqual(openApiSpec);
  });
});
