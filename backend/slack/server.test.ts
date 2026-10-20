import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSlackServer } from "./server.ts";

// Save connected sessions in a temp folder instead of the repo's .data.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "snapdragons-slack-"));

// Send the session cookie back like a browser, so one test is one browser.
let cookie = "";
async function fetch(input: string | URL | Request, init: RequestInit = {}) {
  const response = await globalThis.fetch(input, { ...init, headers: { ...init.headers, cookie } });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  return response;
}

const servers = new Set<Server>();

async function startServer(fetchImpl?: typeof fetch) {
  const server = createSlackServer({
    port: 0,
    clientId: "test-client",
    clientSecret: "test-secret",
    appUrl: "http://localhost:5173/snapdragons",
    fetch: fetchImpl,
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
  cookie = "";
});

async function connectSlack(base: string) {
  const start = await fetch(base + "/auth/slack/start", { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  await fetch(base + `/auth/slack/callback?state=${state}&code=test`, { redirect: "manual" });
  await fetch(base + "/api/slack/connection/enabled", { method: "POST", body: JSON.stringify({ enabled: true }) });
}

test("records a disconnected Slack fetch as a failed sync", async () => {
  const base = await startServer();
  assert.equal((await fetch(base + "/api/slack/messages")).status, 401);
  const activity = await (await fetch(base + "/api/slack/activity")).json();
  assert.equal(activity.events[0].status, 401);
  assert.equal(activity.events[0].count, null);
});

test("records the count from a successful Slack fetch", async () => {
  const fakeSlack: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/oauth.v2.access") return Response.json({ ok: true, authed_user: { id: "U1", access_token: "private-token" } });
    if (path === "/api/search.messages") return Response.json({ ok: true, messages: { matches: [] } });
    if (path === "/api/conversations.list") return Response.json({ ok: true, channels: [] });
    throw new Error(`Unexpected Slack request: ${path}`);
  };
  const base = await startServer(fakeSlack);
  await connectSlack(base);

  assert.equal((await fetch(base + "/api/slack/messages")).status, 200);
  const activity = await (await fetch(base + "/api/slack/activity")).json();
  assert.equal(activity.events[0].status, 200);
  assert.equal(activity.events[0].count, 0);
  assert.equal(JSON.stringify(activity).includes("private-token"), false);

  await fetch(base + "/api/slack/connection/enabled", { method: "POST", body: JSON.stringify({ enabled: false }) });
  assert.equal((await fetch(base + "/api/slack/messages")).status, 403);
  const disabled = await (await fetch(base + "/api/slack/activity")).json();
  assert.equal(disabled.events[0].status, 403);
  assert.equal(disabled.events[0].count, null);
});

test("records a Slack upstream failure without exposing the error in activity", async () => {
  const fakeSlack: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/oauth.v2.access") return Response.json({ ok: true, authed_user: { id: "U1", access_token: "private-token" } });
    if (path === "/api/search.messages") return Response.json({ ok: false, error: "private upstream detail" });
    throw new Error(`Unexpected Slack request: ${path}`);
  };
  const base = await startServer(fakeSlack);
  await connectSlack(base);

  assert.equal((await fetch(base + "/api/slack/messages")).status, 502);
  const activity = await (await fetch(base + "/api/slack/activity")).json();
  assert.equal(activity.events[0].status, 502);
  assert.equal(activity.events[0].count, null);
  assert.equal(JSON.stringify(activity).includes("private upstream detail"), false);
});

const connectingSlack: typeof fetch = async () => Response.json({ ok: true, authed_user: { id: "U1", access_token: "private-token" } });

test("gives each browser its own Slack connection", async () => {
  const base = await startServer(connectingSlack);
  await connectSlack(base);
  const otherBrowser = { headers: { cookie: `sid=${"b".repeat(64)}` } };

  assert.equal((await (await fetch(base + "/api/slack/connection")).json()).slack.connected, true);
  assert.equal((await (await globalThis.fetch(base + "/api/slack/connection", otherBrowser)).json()).slack.connected, false);
  assert.equal((await globalThis.fetch(base + "/api/slack/messages", otherBrowser)).status, 401);
});

test("keeps a Slack connection after the server restarts", async () => {
  await connectSlack(await startServer(connectingSlack));
  const restarted = await startServer(connectingSlack);

  const { slack } = await (await fetch(restarted + "/api/slack/connection")).json();
  assert.equal(slack.connected, true);
  assert.equal(slack.enabled, true);
});

test("accepts a session cookie the server has not seen and only sets one when missing", async () => {
  const base = await startServer();
  const unseen = await globalThis.fetch(base + "/api/slack/connection", { headers: { cookie: `sid=${"a".repeat(64)}` } });
  const fresh = await globalThis.fetch(base + "/api/slack/connection");

  assert.equal(unseen.status, 200);
  assert.equal(unseen.headers.get("set-cookie"), null);
  assert.match(fresh.headers.get("set-cookie") ?? "", /^sid=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000$/);
});
