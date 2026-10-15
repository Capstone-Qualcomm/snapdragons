import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { createGitHubServer } from "./server.ts";

const servers = new Set<Server>();

async function startServer(): Promise<string> {
  const server = createGitHubServer({ port: 0, appUrl: "http://localhost:5173/snapdragons" });
  servers.add(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
});

test("binds the GitHub backend to IPv4 loopback", async () => {
  await startServer();
  assert.equal(( [...servers][0].address() as AddressInfo).address, "127.0.0.1");
});

test("rejects cross-origin disconnect and enable requests", async () => {
  const base = await startServer();
  for (const path of ["/api/github/connection/disconnect", "/api/github/connection/enabled"]) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 403, `${path} should reject an untrusted Origin`);
  }
});

test("accepts same-origin requests far enough to validate their payload", async () => {
  const base = await startServer();
  const response = await fetch(base + "/api/github/connection/enabled", {
    method: "POST",
    headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
    body: "{invalid",
  });
  assert.equal(response.status, 400);
});
