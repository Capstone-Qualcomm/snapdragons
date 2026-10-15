import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createJiraServer } from "./server.ts";

// Save connected sessions in a temp folder instead of the repo's .data.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "snapdragons-jira-"));

// Send the session cookie back like a browser, so one test is one browser.
let cookie = "";
async function fetch(input: string | URL | Request, init: RequestInit = {}) {
  const response = await globalThis.fetch(input, { ...init, headers: { ...init.headers, cookie } });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  return response;
}

type JiraFetchOptions = {
  onRequest?: (request: { url: URL; init: RequestInit }) => void;
  fields?: Array<{ id: string; name: string }>;
  issues?: Array<{ key: string; fields: Record<string, unknown> }>;
  transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
};

type StartServerOptions = { fetch?: typeof fetch; configured?: boolean };

const servers = new Set<Server>();

function createJiraFetch({ onRequest, fields, issues, transitions }: JiraFetchOptions = {}): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    onRequest?.({ url, init });

    if (url.hostname === "auth.atlassian.com") {
      return Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 });
    }
    if (url.pathname === "/oauth/token/accessible-resources") {
      return Response.json([{ id: "cloud-1", name: "Example", url: "https://example.atlassian.net" }]);
    }
    if (url.pathname.endsWith("/rest/api/3/field")) {
      return Response.json(fields ?? [
        { id: "customfield_10016", name: "Story Points" },
        { id: "customfield_10020", name: "Sprint" },
      ]);
    }
    if (url.pathname.endsWith("/rest/api/3/search/jql")) {
      return Response.json({ issues: issues ?? [exampleIssue()], isLast: true });
    }
    if (url.pathname.endsWith("/transitions")) {
      return Response.json({ transitions: transitions ?? [{ id: "31", name: "Start", to: { name: "In Progress" } }] });
    }
    if (url.pathname.includes("/rest/api/3/issue/")) return new Response(null, { status: 204 });

    throw new Error(`Unexpected Jira request: ${url}`);
  };
}

function exampleIssue() {
  return {
    key: "SD-7",
    fields: {
      summary: "Test issue",
      status: { name: "To Do" },
      issuetype: { name: "Task" },
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }] },
      labels: ["backend"],
      reporter: { displayName: "Riley" },
      customfield_10016: 3,
      customfield_10020: [{ name: "Sprint 4" }],
    },
  };
}

async function startServer(options: StartServerOptions = {}): Promise<string> {
  const fetchImpl = options.fetch ?? createJiraFetch();
  const configured = options.configured ?? true;
  const server = createJiraServer({
    port: 0,
    clientId: configured ? "test-client" : undefined,
    clientSecret: configured ? "test-secret" : undefined,
    appUrl: "http://frontend.test",
    fetch: fetchImpl,
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
  cookie = "";
});

async function request(baseUrl: string, path: string, options?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

async function connectJira(baseUrl: string): Promise<Response> {
  const startResponse = await fetch(`${baseUrl}/auth/jira/start`, { redirect: "manual" });
  const authorizeLocation = startResponse.headers.get("location");
  assert.ok(authorizeLocation);
  const authorizeUrl = new URL(authorizeLocation);
  const state = authorizeUrl.searchParams.get("state");
  assert.ok(state);
  const callbackUrl = new URL("/auth/jira/callback", baseUrl);
  callbackUrl.searchParams.set("state", state);
  callbackUrl.searchParams.set("code", "test-code");
  return fetch(callbackUrl, { redirect: "manual" });
}

test("reports Jira as configured before connecting", async () => {
  const baseUrl = await startServer();
  const { body } = await request(baseUrl, "/api/jira/connection");

  assert.equal(body.jira.configured, true);
  assert.equal(body.jira.connected, false);
});

test("reports Jira as unconfigured when OAuth credentials are missing", async () => {
  const baseUrl = await startServer({ configured: false });
  const { body } = await request(baseUrl, "/api/jira/connection");

  assert.equal(body.jira.configured, false);
});

test("redirects to Settings when OAuth is not configured", async () => {
  const baseUrl = await startServer({ configured: false });
  const response = await fetch(`${baseUrl}/auth/jira/start`, { redirect: "manual" });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://frontend.test/settings?jira=unconfigured");
});

test("rejects issue requests before Jira is connected", async () => {
  const baseUrl = await startServer();
  const { response, body } = await request(baseUrl, "/api/jira/issues");

  assert.equal(response.status, 401);
  assert.match(body.error, /not connected/i);
  const activity = await request(baseUrl, "/api/jira/activity");
  assert.equal(activity.body.events[0].status, 401);
  assert.equal(activity.body.events[0].count, null);
});

test("records a real Jira fetch without exposing issue contents in activity", async () => {
  const baseUrl = await startServer();
  await connectJira(baseUrl);
  const issues = await request(baseUrl, "/api/jira/issues");
  const activity = await request(baseUrl, "/api/jira/activity");

  assert.equal(issues.response.status, 200);
  assert.equal(activity.body.events[0].status, 200);
  assert.equal(activity.body.events[0].count, 1);
  assert.equal(JSON.stringify(activity.body).includes("Test issue"), false);
  assert.equal(JSON.stringify(activity.body).includes("test-access"), false);
});

test("records a disabled Jira fetch", async () => {
  const baseUrl = await startServer();
  await connectJira(baseUrl);
  await request(baseUrl, "/api/jira/connection/enabled", {
    method: "POST", body: JSON.stringify({ enabled: false }),
  });

  assert.equal((await request(baseUrl, "/api/jira/issues")).response.status, 403);
  const activity = await request(baseUrl, "/api/jira/activity");
  assert.deepEqual(
    { status: activity.body.events[0].status, count: activity.body.events[0].count },
    { status: 403, count: null },
  );
});

test("records a Jira upstream failure without exposing the error in activity", async () => {
  const normalFetch = createJiraFetch();
  const failingFetch: typeof fetch = (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/rest/api/3/field")) throw new Error("private upstream detail");
    return normalFetch(input, init);
  };
  const baseUrl = await startServer({ fetch: failingFetch });
  await connectJira(baseUrl);

  assert.equal((await request(baseUrl, "/api/jira/issues")).response.status, 502);
  const activity = await request(baseUrl, "/api/jira/activity");
  assert.equal(activity.body.events[0].status, 502);
  assert.equal(activity.body.events[0].count, null);
  assert.equal(JSON.stringify(activity.body).includes("private upstream detail"), false);
});

test("redirects OAuth start to Atlassian with a state value", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/auth/jira/start`, { redirect: "manual" });
  const authorizeLocation = response.headers.get("location");
  assert.ok(authorizeLocation);
  const authorizeUrl = new URL(authorizeLocation);

  assert.equal(response.status, 302);
  assert.equal(authorizeUrl.hostname, "auth.atlassian.com");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "test-client");
  assert.ok(authorizeUrl.searchParams.get("state"));
});

test("rejects an OAuth callback with an unknown state", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/auth/jira/callback?state=unknown&code=test-code`, { redirect: "manual" });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://frontend.test/settings?jira=invalid_state");
});

test("connects the first accessible Jira site after OAuth", async () => {
  const baseUrl = await startServer();
  const callback = await connectJira(baseUrl);
  const { body } = await request(baseUrl, "/api/jira/connection");

  assert.equal(callback.headers.get("location"), "http://frontend.test/settings?jira=connected");
  assert.equal(body.jira.connected, true);
  assert.equal(body.jira.cloudId, "cloud-1");
  assert.equal(body.jira.sites[0].url, "https://example.atlassian.net");
});

test("maps Jira issue fields into the report response", async () => {
  const baseUrl = await startServer();
  await connectJira(baseUrl);
  const { response, body } = await request(baseUrl, "/api/jira/issues");

  assert.equal(response.status, 200);
  assert.deepEqual(body.issues[0], {
    key: "SD-7",
    summary: "Test issue",
    status: "To Do",
    issueType: "Task",
    updated: null,
    url: "https://example.atlassian.net/browse/SD-7",
    description: "Details",
    sprints: ["Sprint 4"],
    labels: ["backend"],
    storyPointEstimate: 3,
    reporter: "Riley",
  });
});

test("returns available Jira status transitions", async () => {
  const baseUrl = await startServer();
  await connectJira(baseUrl);
  const { response, body } = await request(baseUrl, "/api/jira/issues/SD-7/transitions");

  assert.equal(response.status, 200);
  assert.deepEqual(body.transitions, [{ id: "31", name: "Start", status: "In Progress" }]);
});

test("updates an issue description and story point estimate", async () => {
  let updateBody: { fields: Record<string, unknown> } | undefined;
  const baseUrl = await startServer({ fetch: createJiraFetch({
    onRequest: ({ url, init }) => {
      if (url.pathname.endsWith("/rest/api/3/issue/SD-7") && init.method === "PUT" && typeof init.body === "string") {
        updateBody = JSON.parse(init.body);
      }
    },
  }) });
  await connectJira(baseUrl);
  const { response, body } = await request(baseUrl, "/api/jira/issues/SD-7", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "Updated description", storyPointEstimate: 5 }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.ok(updateBody);
  assert.equal(updateBody.fields.customfield_10016, 5);
  const description = updateBody.fields.description as { content: Array<{ content?: Array<{ text?: string }> }> };
  assert.equal(description.content[0].content?.[0].text, "Updated description");
});

test("changes an issue status using the requested transition", async () => {
  let transitionBody: { transition: { id: string } } | undefined;
  const baseUrl = await startServer({ fetch: createJiraFetch({
    onRequest: ({ url, init }) => {
      if (url.pathname.endsWith("/transitions") && init.method === "POST" && typeof init.body === "string") {
        transitionBody = JSON.parse(init.body);
      }
    },
  }) });
  await connectJira(baseUrl);
  const { response } = await request(baseUrl, "/api/jira/issues/SD-7", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transitionId: "31" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(transitionBody, { transition: { id: "31" } });
});

test("rejects story point estimates outside the allowed Fibonacci values", async () => {
  let issueWasUpdated = false;
  const baseUrl = await startServer({ fetch: createJiraFetch({
    onRequest: ({ url, init }) => {
      if (url.pathname.includes("/rest/api/3/issue/") && init.method === "PUT") issueWasUpdated = true;
    },
  }) });
  await connectJira(baseUrl);
  const { response, body } = await request(baseUrl, "/api/jira/issues/SD-7", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storyPointEstimate: 4 }),
  });

  assert.equal(response.status, 400);
  assert.match(body.error, /Fibonacci/);
  assert.equal(issueWasUpdated, false);
});

test("rejects an update when no changes are provided", async () => {
  const baseUrl = await startServer();
  await connectJira(baseUrl);
  const { response, body } = await request(baseUrl, "/api/jira/issues/SD-7", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 400);
  assert.match(body.error, /No changes/);
});

test("records Jira API requests in the Q-01 activity log", async () => {
  const baseUrl = await startServer();
  await connectJira(baseUrl);
  await request(baseUrl, "/api/jira/issues/SD-7/transitions");
  const { body } = await request(baseUrl, "/api/jira/logs");

  const transitionLog = body.logs.find((log: { path: string }) => log.path === "/api/jira/issues/SD-7/transitions");
  assert.equal(transitionLog.node, "Q-01");
  assert.equal(transitionLog.method, "GET");
});
