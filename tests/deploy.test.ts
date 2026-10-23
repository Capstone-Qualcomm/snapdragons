import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

// Every /api/<name> the frontend calls, e.g. "api/assistant".
const called = new Set(
  sources(join(root, "frontend/src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\bapi\/([a-z][a-z0-9-]*)/g)].map((m) => `api/${m[1]}`),
  ),
);

test("the frontend calls some API paths", () => {
  assert.ok(called.has("api/cluster"));
});

test("the live site's Caddyfile sends every API path the frontend calls to a backend", () => {
  const caddy = readFileSync(join(root, "deploy/Caddyfile"), "utf8");
  const routed = [...caddy.matchAll(/\/snapdragons\/(api\/[a-z0-9-]+)\/\*/g)].map((m) => m[1]);
  const missing = [...called].filter((path) => !routed.includes(path));
  assert.deepEqual(missing, [], `add these to deploy/Caddyfile: ${missing.join(", ")}`);
});

