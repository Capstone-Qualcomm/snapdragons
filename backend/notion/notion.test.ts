import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { createNotionApi } from "./notion-api.ts";
import { createNotionAuth } from "./notion-auth.ts";
import type { NotionConnection } from "./notion-auth.ts";

function connection(): NotionConnection {
  return {
    connected: true,
    enabled: true,
    connectedAt: "2026-01-01T00:00:00.000Z",
    token: { access_token: "old-access", refresh_token: "old-refresh" },
    workspaceId: "old-workspace-id",
    workspaceName: "Old workspace",
    workspaceIcon: null,
    botId: "old-bot",
    owner: null,
  };
}

test("a pending token refresh cannot overwrite a newly connected Notion workspace", async () => {
  const notionConnection = connection();
  let finishRefresh!: (response: Response) => void;
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { grant_type: string };
    if (body.grant_type === "refresh_token") {
      refreshStarted();
      return await new Promise<Response>((resolve) => { finishRefresh = resolve; });
    }
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      workspace_id: "new-workspace-id",
      workspace_name: "New workspace",
      bot_id: "new-bot",
    });
  };
  const auth = createNotionAuth({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    appUrl: "http://localhost:5173",
    fetchImpl,
    notionConnection,
  });

  const oldRefresh = auth.getAccessToken(true);
  await started;

  let redirectLocation = "";
  const response = {
    writeHead(_status: number, headers?: Record<string, string>) { redirectLocation = headers?.Location ?? ""; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  auth.start(response);
  const state = new URL(redirectLocation).searchParams.get("state");
  assert.ok(state);
  await auth.handleCallback(new URL(`http://localhost/callback?state=${state}&code=authorization-code`), response);
  const newToken = notionConnection.token;
  assert.equal(notionConnection.workspaceName, "New workspace");

  finishRefresh(Response.json({ access_token: "stale-access", refresh_token: "stale-refresh" }));
  await assert.rejects(oldRefresh, /connection changed/i);
  assert.equal(notionConnection.token, newToken);
  assert.equal(notionConnection.token?.access_token, "new-access");
  assert.equal(notionConnection.workspaceName, "New workspace");
});

test("Notion page search follows cursors and returns pages from every response", async () => {
  const notionConnection = connection();
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) {
      return Response.json({
        results: [{
          object: "page",
          id: "page-one",
          url: "https://www.notion.so/page-one",
          last_edited_time: "2026-01-02T00:00:00.000Z",
          properties: { title: { type: "title", title: [{ plain_text: "First page" }] } },
        }],
        has_more: true,
        next_cursor: "cursor-two",
      });
    }
    return Response.json({
      results: [{
        object: "page",
        id: "page-two",
        url: "https://www.notion.so/page-two",
        last_edited_time: "2026-01-03T00:00:00.000Z",
        properties: { Name: { type: "title", title: [{ plain_text: "Second page" }] } },
      }],
      has_more: false,
    });
  };
  const api = createNotionApi({ notionConnection, fetchImpl, getAccessToken: async () => "access-token" });

  const pages = await api.getPages();

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].start_cursor, undefined);
  assert.equal(bodies[1].start_cursor, "cursor-two");
  assert.deepEqual(pages.map(({ id, title }) => ({ id, title })), [
    { id: "page-one", title: "First page" },
    { id: "page-two", title: "Second page" },
  ]);
});
