import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { createOutlookServer } from "./server.ts";

// Save connected sessions in a temp folder instead of the repo's .data.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "snapdragons-outlook-"));

// Send the session cookie back like a browser, so one test is one browser.
let cookie = "";
async function fetch(input: string | URL | Request, init: RequestInit = {}) {
  const response = await globalThis.fetch(input, { ...init, headers: { ...init.headers, cookie } });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  return response;
}

const servers = new Set<Server>();
const appOrigin = "http://localhost:5173";

async function startServer(fetchImpl: typeof fetch): Promise<string> {
  const server = createOutlookServer({
    port: 0,
    appUrl: `${appOrigin}/snapdragons`,
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

type GraphCall = { method: string; path: string; body: string | null };

// Microsoft sign-in and Graph, with the mail routes a test needs. Every call is recorded.
function fakeMicrosoft(mail: (call: GraphCall, url: URL) => Response | undefined = () => undefined) {
  const calls: GraphCall[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? "GET", path: url.pathname, body: typeof init.body === "string" ? init.body : null };
    calls.push(call);
    if (url.pathname === "/common/oauth2/v2.0/token") {
      return Response.json({ access_token: "private-token", refresh_token: "refresh", expires_in: 3600 });
    }
    if (url.pathname === "/v1.0/me") return Response.json({ id: "u1", displayName: "Sam Tester", mail: "sam@example.com" });
    const response = mail(call, url);
    if (response) return response;
    throw new Error(`Unexpected Microsoft request: ${call.method} ${url}`);
  };
  return { fetchImpl, calls };
}

async function connectOutlook(base: string) {
  const start = await fetch(base + "/auth/outlook/start", { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return fetch(base + `/auth/outlook/callback?state=${state}&code=test`, { redirect: "manual" });
}

function post(base: string, path: string, body?: unknown, origin = appOrigin) {
  return fetch(base + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const unread = (id: string, isRead = false) => ({
  id, isRead, subject: `Subject ${id}`, receivedDateTime: "2026-10-30T15:00:00Z", from: { emailAddress: { name: `Sender ${id}` } },
});

test("turns Outlook on when it connects and shows who signed in", async () => {
  const base = await startServer(fakeMicrosoft().fetchImpl);
  const callback = await connectOutlook(base);
  assert.equal(callback.headers.get("location"), `${appOrigin}/snapdragons/today?outlook=connected`);

  const { outlook } = await (await fetch(base + "/api/outlook/connection")).json() as { outlook: Record<string, unknown> };
  assert.equal(outlook.connected, true);
  assert.equal(outlook.enabled, true);
  assert.equal(outlook.user, "Sam Tester");
});

test("lists unread messages from every page and leaves out read ones", async () => {
  const { fetchImpl } = fakeMicrosoft((call, url) => {
    if (call.path !== "/v1.0/me/mailFolders/inbox/messages") return undefined;
    if (url.searchParams.get("page") === "2") return Response.json({ value: [unread("m3")] });
    return Response.json({
      value: [unread("m1"), unread("m2", true)],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=2",
    });
  });
  const base = await startServer(fetchImpl);
  await connectOutlook(base);

  const { messages } = await (await fetch(base + "/api/outlook/messages")).json() as { messages: Array<{ id: string; from: string }> };
  assert.deepEqual(messages.map(({ id, from }) => [id, from]), [["m1", "Sender m1"], ["m3", "Sender m3"]]);
});

test("refuses a next page outside Microsoft Graph", async () => {
  const { fetchImpl } = fakeMicrosoft((call) => call.path === "/v1.0/me/mailFolders/inbox/messages"
    ? Response.json({ value: [unread("m1")], "@odata.nextLink": "https://attacker.example/steal" })
    : undefined);
  const base = await startServer(fetchImpl);
  await connectOutlook(base);

  assert.equal((await fetch(base + "/api/outlook/messages")).status, 502);
});

test("sends a reply as escaped HTML and marks the message read", async () => {
  const { fetchImpl, calls } = fakeMicrosoft((call) => {
    if (call.path === "/v1.0/me/messages/m1/reply") return new Response(null, { status: 202 });
    if (call.path === "/v1.0/me/messages/m1" && call.method === "PATCH") return Response.json({});
    return undefined;
  });
  const base = await startServer(fetchImpl);
  await connectOutlook(base);

  const response = await post(base, "/api/outlook/messages/m1/reply", { comment: "Sounds good <b>Tuesday</b>\n\nThanks" });
  assert.deepEqual(await response.json(), { ok: true, markedRead: true });
  const reply = JSON.parse(calls.find((call) => call.path.endsWith("/reply"))!.body!);
  assert.equal(reply.message.body.content, "<p>Sounds good &lt;b&gt;Tuesday&lt;/b&gt;</p><p>Thanks</p>");
  assert.equal(calls.find((call) => call.method === "PATCH")!.body, JSON.stringify({ isRead: true }));
});

test("a reply that was sent is not reported as failed when marking it read fails", async () => {
  const { fetchImpl } = fakeMicrosoft((call) => {
    if (call.path === "/v1.0/me/messages/m1/reply") return new Response(null, { status: 202 });
    if (call.method === "PATCH") return new Response(null, { status: 503 });
    return undefined;
  });
  const base = await startServer(fetchImpl);
  await connectOutlook(base);

  const response = await post(base, "/api/outlook/messages/m1/reply", { comment: "On it" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, markedRead: false });
});

test("rejects a blank reply without sending anything", async () => {
  const { fetchImpl, calls } = fakeMicrosoft();
  const base = await startServer(fetchImpl);
  await connectOutlook(base);
  const before = calls.length;

  assert.equal((await post(base, "/api/outlook/messages/m1/reply", { comment: "   " })).status, 400);
  assert.equal(calls.length, before);
});

test("deletes a message, but not while Outlook is turned off", async () => {
  const { fetchImpl, calls } = fakeMicrosoft((call) => call.method === "DELETE" && call.path === "/v1.0/me/messages/m1"
    ? new Response(null, { status: 204 })
    : undefined);
  const base = await startServer(fetchImpl);
  await connectOutlook(base);

  assert.equal((await post(base, "/api/outlook/messages/m1/delete")).status, 200);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);

  await post(base, "/api/outlook/connection/enabled", { enabled: false });
  assert.equal((await post(base, "/api/outlook/messages/m1/delete")).status, 403);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("rejects mail changes from other sites", async () => {
  const { fetchImpl, calls } = fakeMicrosoft();
  const base = await startServer(fetchImpl);
  await connectOutlook(base);
  const before = calls.length;

  for (const path of ["/api/outlook/messages/m1/delete", "/api/outlook/messages/m1/reply"]) {
    assert.equal((await post(base, path, { comment: "hi" }, "https://attacker.example")).status, 403, path);
  }
  assert.equal(calls.length, before);
});

test("keeps an Outlook connection after the server restarts", async () => {
  const { fetchImpl } = fakeMicrosoft((call) => call.path === "/v1.0/me/mailFolders/inbox/messages" ? Response.json({ value: [] }) : undefined);
  await connectOutlook(await startServer(fetchImpl));
  const restarted = await startServer(fetchImpl);

  const { outlook } = await (await fetch(restarted + "/api/outlook/connection")).json() as { outlook: { user: string | null } };
  assert.equal(outlook.user, "Sam Tester");
  assert.equal((await fetch(restarted + "/api/outlook/messages")).status, 200);
});
