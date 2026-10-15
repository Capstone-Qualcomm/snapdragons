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
