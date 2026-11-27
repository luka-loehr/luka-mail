#!/usr/bin/env node
// Validates openapi/openapi.json in CI and local checks:
// 1. Byte-for-byte sync with scripts/generate-openapi.mjs.
// 2. OpenAPI 3.1.0 structural rules: unique operationIds, summaries, descriptions,
//    parameter & property descriptions, and resolvable $ref pointers.
// 3. Client contract parity: every HTTP endpoint invoked by cli/src/main.rs and
//    ios/LukaMail/Services/APIClient.swift + NativeAuthSession.swift exists in
//    openapi/openapi.json with the matching HTTP method.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializedOpenApiSpec } from "./generate-openapi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(ROOT, "openapi", "openapi.json");
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

const errors = [];
if (!fs.existsSync(SPEC_PATH)) {
  console.error("openapi/openapi.json is missing; run `npm run openapi:generate`");
  process.exit(1);
}

const raw = fs.readFileSync(SPEC_PATH, "utf8");
if (raw !== serializedOpenApiSpec) {
  errors.push("openapi/openapi.json is out of sync with scripts/generate-openapi.mjs; run `npm run openapi:generate`");
}

const spec = JSON.parse(raw);
if (spec.openapi !== "3.1.0") errors.push(`Expected openapi 3.1.0, got ${spec.openapi}`);

function resolvePointer(pointer) {
  if (!pointer.startsWith("#/")) return null;
  const parts = pointer.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = spec;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || !(part in current)) return null;
    current = current[part];
  }
  return current;
}

function walkSchema(node, trail) {
  if (!node || typeof node !== "object") return;
  if ("$ref" in node) {
    if (!resolvePointer(node.$ref)) errors.push(`${trail}: unresolved $ref ${node.$ref}`);
    return;
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [prop, value] of Object.entries(node.properties)) {
      if (value && typeof value === "object" && !("$ref" in value) && (!value.description || !String(value.description).trim())) {
        errors.push(`${trail}.properties.${prop}: missing description`);
      }
      walkSchema(value, `${trail}.properties.${prop}`);
    }
  }
  if (node.items) walkSchema(node.items, `${trail}.items`);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(node[key])) node[key].forEach((sub, idx) => walkSchema(sub, `${trail}.${key}[${idx}]`));
  }
}

for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
  if (!schema.description || !String(schema.description).trim()) {
    errors.push(`components.schemas.${name}: missing description`);
  }
  walkSchema(schema, `components.schemas.${name}`);
}

const operationIds = new Set();
let operationCount = 0;
for (const [routePath, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (!HTTP_METHODS.has(method)) continue;
    operationCount += 1;
    const label = `${method.toUpperCase()} ${routePath}`;
    if (!op.operationId) errors.push(`${label}: missing operationId`);
    else if (operationIds.has(op.operationId)) errors.push(`${label}: duplicate operationId ${op.operationId}`);
    else operationIds.add(op.operationId);
    if (!op.summary?.trim()) errors.push(`${label}: missing summary`);
    if (!op.description?.trim()) errors.push(`${label}: missing description`);
    if (!Array.isArray(op.tags) || op.tags.length === 0) errors.push(`${label}: missing tags`);
    if (!op.responses || Object.keys(op.responses).length === 0) errors.push(`${label}: missing responses`);

    for (const [idx, param] of (op.parameters ?? []).entries()) {
      const target = "$ref" in param ? resolvePointer(param.$ref) : param;
      if (!target) {
        errors.push(`${label}: unresolved parameter $ref ${param.$ref}`);
        continue;
      }
      if (!target.description?.trim()) errors.push(`${label} param[${idx}] (${target.name}): missing description`);
      if (target.schema) walkSchema(target.schema, `${label}.param(${target.name})`);
    }
    if (op.requestBody) {
      const target = "$ref" in op.requestBody ? resolvePointer(op.requestBody.$ref) : op.requestBody;
      if (!target?.description?.trim()) errors.push(`${label}: requestBody missing description`);
      for (const [media, content] of Object.entries(target?.content ?? {})) {
        walkSchema(content.schema, `${label}.requestBody(${media})`);
      }
    }
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      const target = "$ref" in response ? resolvePointer(response.$ref) : response;
      if (!target) {
        errors.push(`${label} response ${status}: unresolved $ref ${response.$ref}`);
        continue;
      }
      if (!target.description?.trim()) errors.push(`${label} response ${status}: missing description`);
      for (const [media, content] of Object.entries(target.content ?? {})) {
        walkSchema(content.schema, `${label}.response(${status},${media})`);
      }
    }
  }
}

function normalizeClientPath(rawPath) {
  const withoutQuery = rawPath.split("?")[0];
  const prefixed = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return prefixed
    .replaceAll(/\\\((?:[^()]+|\([^()]*\))+\)/g, "{param}")
    .replaceAll(/\{[^}]*\}/g, "{param}");
}

const specShapeIndex = new Map();
for (const [routePath, methods] of Object.entries(spec.paths ?? {})) {
  const normalized = routePath.replaceAll(/\{[^}]+\}/g, "{param}");
  specShapeIndex.set(normalized, new Set(Object.keys(methods).map((m) => m.toUpperCase())));
}

function assertClientCall(source, method, rawPath) {
  const normalized = normalizeClientPath(rawPath);
  const methods = specShapeIndex.get(normalized);
  if (!methods) {
    errors.push(`${source}: calls undocumented path ${rawPath} (normalized ${normalized})`);
    return;
  }
  if (method && !methods.has(method.toUpperCase())) {
    errors.push(`${source}: calls ${method.toUpperCase()} ${rawPath}, but OpenAPI only declares [${[...methods].join(", ")}]`);
  }
}

// Check Rust CLI routes in cli/src/main.rs
const cliSource = fs.readFileSync(path.join(ROOT, "cli", "src", "main.rs"), "utf8");
for (const match of cliSource.matchAll(/Method::(GET|POST|PUT|PATCH|DELETE)\s*,\s*(?:&\s*format!\(\s*)?"(\/(?:v1|auth|health|\.well-known)[^"]*)"/g)) {
  assertClientCall("cli/src/main.rs", match[1], match[2]);
}
for (const match of cliSource.matchAll(/collect_pages\(\s*api,\s*"(\/v1\/[^"]+)"/g)) {
  assertClientCall("cli/src/main.rs", "GET", match[1]);
}

// Check Swift iOS/macOS client routes in APIClient.swift and NativeAuthSession.swift
const swiftApi = fs.readFileSync(path.join(ROOT, "ios", "LukaMail", "Services", "APIClient.swift"), "utf8");
for (const match of swiftApi.matchAll(/(?:json|data|makeRequest)\(\s*"((?:v1|auth)\/[^"]+)"(?:\s*,\s*query:\s*(?:\[[^\]]*\]|[A-Za-z0-9_]+))?(?:\s*,\s*method:\s*"([A-Z]+)")?/g)) {
  assertClientCall("ios/APIClient.swift", match[2] ?? "GET", match[1]);
}
const swiftAuth = fs.readFileSync(path.join(ROOT, "ios", "LukaMail", "Services", "NativeAuthSession.swift"), "utf8");
for (const match of swiftAuth.matchAll(/appending\(path:\s*"(auth\/[^"]+)"\)/g)) {
  assertClientCall("ios/NativeAuthSession.swift", null, match[1]);
}

if (errors.length > 0) {
  console.error(`OpenAPI contract check failed with ${errors.length} error(s):`);
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.log(`OpenAPI 3.1.0 contract ok: ${Object.keys(spec.paths).length} paths, ${operationCount} operations, CLI + Apple client parity verified.`);
