import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createNotionServer } from "./server.ts";

const servers = new Set<Server>();

async function start(fetchImpl: typeof fetch, dataDir = mkdtempSync(join(tmpdir(), "snapdragons-notion-"))) {
  process.env.DATA_DIR = dataDir;
  const server = createNotionServer({ port: 0, clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/auth/notion/callback", appUrl: "http://localhost:5173/snapdragons", fetch: fetchImpl });
  servers.add(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dataDir };
}

afterEach(() => {
  for (const server of servers) server.close();
  servers.clear();
});

test("OAuth connection, enabled state, search and disconnect are scoped to the browser session", async () => {
  const calls: string[] = [];
  const fakeNotion: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "token-123", workspace_id: "w1", workspace_name: "Snapdragons" });
    if (url.endsWith("/search")) return Response.json({ results: [{
      object: "page",
      id: "p1",
      url: "https://www.notion.so/release",
      properties: { Name: { type: "title", title: [{ plain_text: "Release" }] } },
    }] });
    if (url.includes("/blocks/p1/children")) return Response.json({ results: [{ object: "block", id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "Release is Friday." }] } }] });
    return Response.json({ error: "missing" }, { status: 404 });
  };
  const { base, dataDir } = await start(fakeNotion);
  const startResponse = await fetch(`${base}/auth/notion/start`, { redirect: "manual" });
  const cookie = startResponse.headers.get("set-cookie")?.split(";")[0];
  const authorize = new URL(startResponse.headers.get("location")!);
  assert.equal(authorize.origin, "https://api.notion.com");
  assert.equal(authorize.searchParams.get("owner"), "user");
  assert.ok(cookie);
  const callback = await fetch(`${base}/auth/notion/callback?state=${authorize.searchParams.get("state")}&code=oauth-code`, { headers: { Cookie: cookie! }, redirect: "manual" });
  assert.equal(callback.headers.get("location"), "http://localhost:5173/snapdragons/connections?notion=connected");
  const connection = await (await fetch(`${base}/api/notion/connection`, { headers: { Cookie: cookie! } })).json() as { notion: Record<string, unknown> };
  assert.equal(connection.notion.connected, true);
  assert.equal(connection.notion.workspace, "Snapdragons");

  const restarted = await start(async () => { throw new Error("A persisted connection should not need a network request yet."); }, dataDir);
  const afterRestart = await (await fetch(`${restarted.base}/api/notion/connection`, { headers: { Cookie: cookie! } })).json() as { notion: Record<string, unknown> };
  assert.equal(afterRestart.notion.connected, true);
  assert.equal(afterRestart.notion.workspace, "Snapdragons");

  const search = await fetch(`${base}/api/notion/search`, { method: "POST", headers: { Cookie: cookie!, Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: JSON.stringify({ query: "release" }) });
  const pages = await search.json() as { pages: Array<{ title: string; text: string }> };
  assert.equal(pages.pages[0].title, "Release");
  assert.equal(pages.pages[0].text, "Release is Friday.\n");

  const off = await fetch(`${base}/api/notion/connection/enabled`, { method: "POST", headers: { Cookie: cookie!, Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  const blocked = await fetch(`${base}/api/notion/search`, { method: "POST", headers: { Cookie: cookie!, Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: JSON.stringify({ query: "release" }) });
  assert.equal(blocked.status, 403);
  const disconnected = await fetch(`${base}/api/notion/connection/disconnect`, { method: "POST", headers: { Cookie: cookie!, Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(disconnected.status, 200);
  assert.equal(calls.some((url) => url.endsWith("/oauth/token")), true);
});

test("rejects cross-origin actions and handles invalid bodies and states", async () => {
  const { base } = await start(async () => Response.json({ access_token: "token" }));
  const crossOrigin = await fetch(`${base}/api/notion/connection/enabled`, { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(crossOrigin.status, 403);
  const badBody = await fetch(`${base}/api/notion/search`, { method: "POST", headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: "not-json" });
  assert.equal(badBody.status, 401);
  const invalidState = await fetch(`${base}/auth/notion/callback?state=invalid&code=one`, { redirect: "manual" });
  assert.equal(invalidState.status, 302);
  assert.match(invalidState.headers.get("location")!, /notion=invalid_state/);
});
