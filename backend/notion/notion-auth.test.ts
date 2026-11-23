import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { createNotionAuth } from "./notion-auth.ts";
import type { NotionConnection } from "./notion-auth.ts";

function response() {
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), { writeHead: (status: number, fields: Record<string, string>) => { headers.status = String(status); Object.assign(headers, fields); }, end() {} });
  return { res: res as unknown as ServerResponse, headers };
}

test("uses state for OAuth and saves the selected workspace token server-side", async () => {
  const connection: NotionConnection = { connected: false, enabled: false, connectedAt: null, workspaceId: null, workspaceName: null, ownerName: null, token: null };
  let exchange: { url: string; init?: RequestInit } | undefined;
  const auth = createNotionAuth({
    clientId: "client", clientSecret: "secret", redirectUri: "http://localhost:3007/auth/notion/callback", appUrl: "http://localhost:5173/snapdragons", connection,
    fetchImpl: async (input, init) => { exchange = { url: String(input), init }; return Response.json({ access_token: "notion-access", workspace_id: "workspace-1", workspace_name: "Snapdragons", owner: { user: { name: "Dani" } } }); },
  });
  const start = response();
  auth.startAuthorization(start.res);
  const authorize = new URL(start.headers.Location);
  assert.equal(authorize.searchParams.get("owner"), "user");
  const state = authorize.searchParams.get("state")!;
  const callback = response();
  await auth.handleCallback(new URL(`http://localhost/auth/notion/callback?state=${state}&code=one-time-code`), callback.res);
  assert.equal(connection.connected, true);
  assert.equal(connection.enabled, true);
  assert.equal(connection.token, "notion-access");
  assert.equal(connection.workspaceName, "Snapdragons");
  assert.equal(connection.ownerName, "Dani");
  assert.equal(exchange?.url, "https://api.notion.com/v1/oauth/token");
  assert.equal((exchange?.init?.headers as Record<string, string>).Authorization?.startsWith("Basic "), true);
  assert.equal(callback.headers.Location, "http://localhost:5173/snapdragons/connections?notion=connected");
});

test("rejects reused or invalid state and clears credentials on disconnect", async () => {
  const connection: NotionConnection = { connected: false, enabled: false, connectedAt: null, workspaceId: null, workspaceName: null, ownerName: null, token: null };
  const auth = createNotionAuth({ clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/callback", appUrl: "http://localhost", connection, fetchImpl: async () => Response.json({ access_token: "no" }) });
  const invalid = response();
  await auth.handleCallback(new URL("http://localhost/callback?state=bad&code=x"), invalid.res);
  assert.equal(invalid.headers.Location, "http://localhost/connections?notion=invalid_state");
  const start = response();
  auth.startAuthorization(start.res);
  const state = new URL(start.headers.Location).searchParams.get("state")!;
  await auth.handleCallback(new URL(`http://localhost/callback?state=${state}&code=x`), response().res);
  await auth.handleCallback(new URL(`http://localhost/callback?state=${state}&code=x`), invalid.res);
  assert.equal(invalid.headers.Location, "http://localhost/connections?notion=invalid_state");
  auth.reset();
  assert.deepEqual(connection, { connected: false, enabled: false, connectedAt: null, workspaceId: null, workspaceName: null, ownerName: null, token: null });
});
