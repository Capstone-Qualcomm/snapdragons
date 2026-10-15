import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { createGitHubServer } from "./server.ts";

// Save connected sessions in a temp folder instead of the repo's .data.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "snapdragons-github-"));

// Send the session cookie back like a browser, so one test is one browser.
let cookie = "";
async function fetch(input: string | URL | Request, init: RequestInit = {}) {
  const response = await globalThis.fetch(input, { ...init, headers: { ...init.headers, cookie } });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  return response;
}

const servers = new Set<Server>();
type ActivityResponse = { events: Array<{ status: number; count: number | null }> };

async function startServer(fetchImpl?: typeof fetch): Promise<string> {
  const server = createGitHubServer({
    port: 0,
    appUrl: "http://localhost:5173/snapdragons",
    clientId: "test-client",
    clientSecret: "test-secret",
    fetch: fetchImpl,
  });
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
  cookie = "";
});

async function connectGitHub(base: string) {
  const start = await fetch(base + "/auth/github/start", { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  await fetch(base + `/auth/github/callback?state=${state}&code=test`, { redirect: "manual" });
  await fetch(base + "/api/github/connection/enabled", {
    method: "POST",
    headers: { Origin: "http://localhost:5173" },
    body: JSON.stringify({ enabled: true }),
  });
}

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

test("records a disconnected GitHub fetch as a failed sync", async () => {
  const base = await startServer();
  assert.equal((await fetch(base + "/api/github/issues")).status, 401);
  const activity = await (await fetch(base + "/api/github/activity")).json() as ActivityResponse;
  assert.equal(activity.events[0].status, 401);
  assert.equal(activity.events[0].count, null);
});

test("records a successful GitHub fetch without exposing the token or issue title", async () => {
  const fakeGitHub: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "private-token", expires_in: 3600 });
    if (url.pathname === "/user") return Response.json({ id: 1, login: "tester" });
    if (url.pathname === "/issues") return Response.json([{
      number: 7, title: "Private task", state: "open", updated_at: "2026-10-15T12:00:00Z",
      html_url: "https://github.com/team/repo/issues/7", repository: { full_name: "team/repo" },
    }]);
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const base = await startServer(fakeGitHub);
  await connectGitHub(base);

  assert.equal((await fetch(base + "/api/github/issues")).status, 200);
  const activity = await (await fetch(base + "/api/github/activity")).json() as ActivityResponse;
  assert.equal(activity.events[0].status, 200);
  assert.equal(activity.events[0].count, 1);
  assert.equal(JSON.stringify(activity).includes("private-token"), false);
  assert.equal(JSON.stringify(activity).includes("Private task"), false);

  await fetch(base + "/api/github/connection/enabled", {
    method: "POST",
    headers: { Origin: "http://localhost:5173" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await fetch(base + "/api/github/issues")).status, 403);
  const disabled = await (await fetch(base + "/api/github/activity")).json() as ActivityResponse;
  assert.equal(disabled.events[0].status, 403);
  assert.equal(disabled.events[0].count, null);
});

test("records a GitHub upstream failure without exposing the error in activity", async () => {
  const fakeGitHub: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "private-token", expires_in: 3600 });
    if (url.pathname === "/user") return Response.json({ id: 1, login: "tester" });
    if (url.pathname === "/issues") return Response.json({ message: "private upstream detail" }, { status: 500 });
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const base = await startServer(fakeGitHub);
  await connectGitHub(base);

  assert.equal((await fetch(base + "/api/github/issues")).status, 502);
  const activity = await (await fetch(base + "/api/github/activity")).json() as ActivityResponse;
  assert.equal(activity.events[0].status, 502);
  assert.equal(activity.events[0].count, null);
  assert.equal(JSON.stringify(activity).includes("private upstream detail"), false);
});
