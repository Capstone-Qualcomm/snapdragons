import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createTeamsServer } from "./server.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "snapdragons-teams-"));

let cookie = "";
async function fetch(input: string | URL | Request, init: RequestInit = {}) {
  const response = await globalThis.fetch(input, { ...init, headers: { Origin: "http://localhost:5173", ...init.headers, cookie } });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  return response;
}

const servers = new Set<Server>();
const appOrigin = "http://localhost:5173";

async function startServer(fetchImpl: typeof fetch) {
  const server = createTeamsServer({
    port: 0,
    appUrl: `${appOrigin}/snapdragons`,
    clientId: "test-client",
    clientSecret: "test-secret",
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

function fakeMicrosoft(graph: (url: URL, init?: RequestInit) => Response | undefined = () => undefined) {
  const tokenRequests: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/common/oauth2/v2.0/token") {
      const body = new URLSearchParams(String(init.body ?? ""));
      tokenRequests.push(body);
      const refreshing = body.get("grant_type") === "refresh_token";
      return Response.json({
        access_token: refreshing ? "refreshed-access-token" : "private-access-token",
        refresh_token: refreshing ? "rotated-refresh-token" : "private-refresh-token",
        expires_in: refreshing ? 3600 : 3600,
      });
    }
    if (url.pathname === "/v1.0/me") return Response.json({ id: "u1", displayName: "Sam Tester", mail: "sam@example.com" });
    const response = graph(url, init);
    if (response) return response;
    throw new Error(`Unexpected Microsoft request: ${url}`);
  };
  return { fetchImpl, tokenRequests };
}

async function connectTeams(base: string) {
  const start = await fetch(base + "/auth/teams/start", { redirect: "manual" });
  const authorizeUrl = new URL(start.headers.get("location")!);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  const callback = await fetch(base + `/auth/teams/callback?state=${authorizeUrl.searchParams.get("state")}&code=test`, { redirect: "manual" });
  return callback;
}

test("signs in with Microsoft and reports the connected user", async () => {
  const { fetchImpl } = fakeMicrosoft();
  const base = await startServer(fetchImpl);

  const callback = await connectTeams(base);
  assert.equal(callback.headers.get("location"), `${appOrigin}/snapdragons/today?teams=connected`);
  const { teams } = await (await fetch(base + "/api/teams/connection")).json() as { teams: Record<string, unknown> };
  assert.equal(teams.connected, true);
  assert.equal(teams.enabled, true);
  assert.equal(teams.user, "Sam Tester");
});

test("refreshes an expired access token before loading messages", async () => {
  const calls: string[] = [];
  const microsoft = fakeMicrosoft((url, init) => {
    if (url.pathname === "/v1.0/me/chats") {
      calls.push(new Headers(init?.headers).get("Authorization") ?? "");
      return Response.json({ value: [] });
    }
    return undefined;
  });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/common/oauth2/v2.0/token") {
      const body = new URLSearchParams(String(init.body ?? ""));
      microsoft.tokenRequests.push(body);
      const refreshing = body.get("grant_type") === "refresh_token";
      return Response.json({
        access_token: refreshing ? "refreshed-access-token" : "private-access-token",
        refresh_token: "private-refresh-token",
        expires_in: refreshing ? 3600 : 0,
      });
    }
    return microsoft.fetchImpl(input, init);
  };
  const base = await startServer(fetchImpl);
  await connectTeams(base);

  assert.equal((await fetch(base + "/api/teams/messages")).status, 200);
  assert.deepEqual(microsoft.tokenRequests.map((request) => request.get("grant_type")), ["authorization_code", "refresh_token"]);
  assert.equal(calls[0], "Bearer refreshed-access-token");
  assert.equal(microsoft.tokenRequests[1].get("refresh_token"), "private-refresh-token");
});

test("selects recent group mentions across pages and the latest inbound direct message", async () => {
  const now = Date.now();
  const date = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const chats = [
    { id: "group1", chatType: "group", topic: "Project", lastUpdatedDateTime: date(2) },
    { id: "direct1", chatType: "oneOnOne", topic: null, lastUpdatedDateTime: date(1) },
  ];
  let directPageRequests = 0;
  const graph = (url: URL) => {
    if (url.pathname === "/v1.0/me/chats") return Response.json({ value: chats });
    if (url.pathname.endsWith("/group1/messages")) {
      if (url.searchParams.get("page") === "2") return Response.json({ value: [
        { id: "mention1", createdDateTime: date(30), from: { user: { id: "u2", displayName: "Jordan" } }, body: { content: "Hi <b>Sam</b>" }, mentions: [{ mentioned: { user: { id: "u1" } } }] },
        { id: "too-old", createdDateTime: date(8 * 24 * 60), from: { user: { id: "u2" } }, mentions: [{ mentioned: { user: { id: "u1" } } }] },
      ] });
      return Response.json({
        value: [{ id: "not-mention", createdDateTime: date(5), from: { user: { id: "u2" } }, body: { content: "Hello" }, mentions: [] }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats/group1/messages?page=2",
      });
    }
    if (url.pathname.endsWith("/direct1/messages")) {
      directPageRequests++;
      if (url.searchParams.get("page") === "2") return Response.json({ value: [
        { id: "older-inbound", createdDateTime: date(15), from: { user: { id: "u3", displayName: "Morgan" } }, body: { content: "Older message" } },
      ] });
      return Response.json({
        value: [
          { id: "latest-inbound", createdDateTime: date(1), from: { user: { id: "u2", displayName: "Taylor" } }, body: { content: "Thanks &amp; welcome" } },
          { id: "older-self", createdDateTime: date(10), from: { user: { id: "u1" } } },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats/direct1/messages?page=2",
      });
    }
    return undefined;
  };
  const { fetchImpl } = fakeMicrosoft(graph);
  const base = await startServer(fetchImpl);
  await connectTeams(base);

  const { messages } = await (await fetch(base + "/api/teams/messages")).json() as { messages: Array<{ id: string; kind: string; from: string; text: string; where: string }> };
  assert.deepEqual(messages.map(({ id, kind, from, text, where }) => [id, kind, from, text, where]), [
    ["direct1:latest-inbound", "dm", "Taylor", "Thanks & welcome", "Direct chat"],
    ["group1:mention1", "mention", "Jordan", "Hi Sam", "Project"],
  ]);
  assert.equal(directPageRequests, 1, "should not request older pages for a direct chat");
});
