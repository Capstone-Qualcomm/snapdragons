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
  return fetch(base + `/auth/github/callback?state=${state}&code=test`, { redirect: "manual" });
}

async function submitComment(base: string, repository = "team/repo", number = 7, body = "Looks good") {
  return fetch(`${base}/api/github/repos/${repository.split("/").map(encodeURIComponent).join("/")}/issues/${number}/comments`, {
    method: "POST",
    headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

function githubWithCommentResponse(commentResponse: (input: string | URL | Request, init?: RequestInit) => Response): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "private-token", expires_in: 3600 });
    if (url.pathname === "/user") return Response.json({ id: 1, login: "tester" });
    if (url.pathname === "/repos/team/repo/issues/7/comments") return commentResponse(input, init);
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
}

const connectingGitHub: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "private-token", expires_in: 3600 });
  if (url.pathname === "/user") return Response.json({ id: 1, login: "tester" });
  throw new Error(`Unexpected GitHub request: ${url}`);
};

test("turns GitHub on when it connects", async () => {
  const base = await startServer(connectingGitHub);
  const callback = await connectGitHub(base);
  assert.equal(callback.headers.get("location"), "http://localhost:5173/snapdragons/today?github=connected");
  const { github } = await (await fetch(base + "/api/github/connection")).json() as { github: { enabled: boolean } };
  assert.equal(github.enabled, true);
});

test("sends a sign-in with an unknown state back as invalid_state", async () => {
  const base = await startServer(connectingGitHub);
  const callback = await fetch(base + "/auth/github/callback?state=unknown&code=test", { redirect: "manual" });
  assert.equal(callback.headers.get("location"), "http://localhost:5173/snapdragons/today?github=invalid_state");
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

test("posts a GitHub issue or pull request comment with the connected user's token", async () => {
  let request: RequestInit | undefined;
  const base = await startServer(githubWithCommentResponse((_input, init) => {
    request = init;
    return Response.json({ id: 42, html_url: "https://github.com/team/repo/issues/7#issuecomment-42" });
  }));
  await connectGitHub(base);

  const response = await submitComment(base);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(request?.method, "POST");
  assert.equal(new Headers(request?.headers).get("Authorization"), "Bearer private-token");
  assert.deepEqual(JSON.parse(String(request?.body)), { body: "Looks good" });
});

test("rejects GitHub comments when disconnected or when the comment is blank", async () => {
  const base = await startServer(connectingGitHub);
  assert.equal((await submitComment(base)).status, 401);

  await connectGitHub(base);
  const blank = await submitComment(base, "team/repo", 7, "  ");
  assert.equal(blank.status, 400);
  assert.match((await blank.json() as { error: string }).error, /cannot be empty/i);
});

test("explains GitHub comment permission failures", async () => {
  const base = await startServer(githubWithCommentResponse(() => Response.json(
    { message: "Resource not accessible by integration" },
    { status: 403, headers: { "X-Accepted-GitHub-Permissions": "issues=write" } },
  )));
  await connectGitHub(base);

  const response = await submitComment(base);
  assert.equal(response.status, 403);
  const result = await response.json() as { error: string };
  assert.match(result.error, /issues=write/);
  assert.match(result.error, /Resource not accessible by integration/);
});

test("distinguishes a GitHub comment rate limit from permission failures", async () => {
  const base = await startServer(githubWithCommentResponse(() => Response.json(
    { message: "API rate limit exceeded" },
    { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 120) } },
  )));
  await connectGitHub(base);

  const response = await submitComment(base);
  assert.equal(response.status, 403);
  assert.match((await response.json() as { error: string }).error, /rate limit reached/i);
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

test("keeps a GitHub connection after the server restarts", async () => {
  const fakeGitHub: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "private-token", expires_in: 3600 });
    if (url.pathname === "/user") return Response.json({ id: 1, login: "tester" });
    if (url.pathname === "/issues") return Response.json([]);
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  await connectGitHub(await startServer(fakeGitHub));
  const restarted = await startServer(fakeGitHub);

  const { github } = await (await fetch(restarted + "/api/github/connection")).json() as { github: { user: string | null } };
  assert.equal(github.user, "tester");
  assert.equal((await fetch(restarted + "/api/github/issues")).status, 200);
});
