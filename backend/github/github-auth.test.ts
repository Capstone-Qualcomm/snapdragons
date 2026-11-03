import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubAuth, type GitHubConnection } from "./github-auth.ts";

function token(accessToken: string) {
  return {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    accessTokenExpiresAt: Date.now() - 1_000,
    refreshTokenExpiresAt: Date.now() + 60_000,
  };
}

function connectedAccount(currentToken: NonNullable<GitHubConnection["token"]>): GitHubConnection {
  return {
    connected: true,
    enabled: true,
    connectedAt: new Date().toISOString(),
    user: { id: 1, login: "old-account" },
    token: currentToken,
  };
}

test("a completed refresh cannot replace a newer connection", async () => {
  let resolveRefresh!: (response: Response) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const refreshResponse = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
  const oldToken = token("old-access");
  const connection = connectedAccount(oldToken);
  const auth = createGitHubAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3004/auth/github/callback",
    appUrl: "http://localhost:5173",
    githubConnection: connection,
    fetchImpl: async () => {
      markStarted();
      return refreshResponse;
    },
  });

  const accessPromise = auth.getAccessToken();
  await started;
  const newToken = token("new-account-access");
  connection.user = { id: 2, login: "new-account" };
  connection.token = newToken;
  resolveRefresh(new Response(JSON.stringify({ access_token: "refreshed-old-access", expires_in: 3600 }), { status: 200 }));

  await assert.rejects(accessPromise, /connection changed/i);
  assert.equal(connection.user?.login, "new-account");
  assert.equal(connection.token, newToken);
});

test("a failed stale refresh cannot reset a newer connection", async () => {
  let resolveRefresh!: (response: Response) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const refreshResponse = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
  const oldToken = token("old-access");
  const connection = connectedAccount(oldToken);
  const auth = createGitHubAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3004/auth/github/callback",
    appUrl: "http://localhost:5173",
    githubConnection: connection,
    fetchImpl: async () => {
      markStarted();
      return refreshResponse;
    },
  });

  const accessPromise = auth.getAccessToken();
  await started;
  const newToken = token("new-account-access");
  connection.user = { id: 2, login: "new-account" };
  connection.token = newToken;
  resolveRefresh(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));

  await assert.rejects(accessPromise, /connection changed/i);
  assert.equal(connection.connected, true);
  assert.equal(connection.user?.login, "new-account");
  assert.equal(connection.token, newToken);
});

function refreshingAuth(connection: GitHubConnection, fetchImpl: typeof fetch) {
  return createGitHubAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3004/auth/github/callback",
    appUrl: "http://localhost:5173",
    githubConnection: connection,
    fetchImpl,
  });
}

test("a network error while refreshing keeps GitHub connected", async () => {
  const connection = connectedAccount(token("old-access"));
  const auth = refreshingAuth(connection, async () => { throw new TypeError("fetch failed"); });

  await assert.rejects(auth.getAccessToken(), /try again/i);
  assert.equal(connection.connected, true);
  assert.equal(connection.token?.refreshToken, "old-access-refresh");
});

test("a refresh token GitHub rejects signs the user out", async () => {
  const connection = connectedAccount(token("old-access"));
  const auth = refreshingAuth(connection, async () => Response.json({ error: "bad_refresh_token" }));

  await assert.rejects(auth.getAccessToken(), /Reconnect GitHub/);
  assert.equal(connection.connected, false);
});

test("requests that need a refresh at the same time share one", async () => {
  const connection = connectedAccount(token("old-access"));
  let calls = 0;
  const auth = refreshingAuth(connection, async () => {
    calls += 1;
    return Response.json({ access_token: "new-access", expires_in: 28800, refresh_token: "new-refresh" });
  });

  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken()]), ["new-access", "new-access"]);
  assert.equal(calls, 1);
  assert.equal(connection.token?.refreshToken, "new-refresh");
});
