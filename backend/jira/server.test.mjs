import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createJiraServer } from "./server.mjs";

const servers = new Set();

function createJiraFetch({ onRequest, fields, issues, transitions } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
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

async function startServer({ fetch = createJiraFetch(), configured = true } = {}) {
  const server = createJiraServer({
    port: 0,
    clientId: configured ? "test-client" : undefined,
    clientSecret: configured ? "test-secret" : undefined,
    appUrl: "http://frontend.test",
    fetch,
  });
  servers.add(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
});

async function request(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

async function connectJira(baseUrl) {
  const startResponse = await fetch(`${baseUrl}/auth/jira/start`, { redirect: "manual" });
  const authorizeUrl = new URL(startResponse.headers.get("location"));
  const callbackUrl = new URL("/auth/jira/callback", baseUrl);
  callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state"));
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
});

test("redirects OAuth start to Atlassian with a state value", async () => {
  const baseUrl = await startServer();
  const response = await fetch(`${baseUrl}/auth/jira/start`, { redirect: "manual" });
  const authorizeUrl = new URL(response.headers.get("location"));

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
  let updateBody;
  const baseUrl = await startServer({ fetch: createJiraFetch({
    onRequest: ({ url, init }) => {
      if (url.pathname.endsWith("/rest/api/3/issue/SD-7") && init.method === "PUT") updateBody = JSON.parse(init.body);
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
  assert.equal(updateBody.fields.customfield_10016, 5);
  assert.equal(updateBody.fields.description.content[0].content[0].text, "Updated description");
});

test("changes an issue status using the requested transition", async () => {
  let transitionBody;
  const baseUrl = await startServer({ fetch: createJiraFetch({
    onRequest: ({ url, init }) => {
      if (url.pathname.endsWith("/transitions") && init.method === "POST") transitionBody = JSON.parse(init.body);
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

  const transitionLog = body.logs.find(({ path }) => path === "/api/jira/issues/SD-7/transitions");
  assert.equal(transitionLog.node, "Q-01");
  assert.equal(transitionLog.method, "GET");
});
