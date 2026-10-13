import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

export type GitHubConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  user: { id: number; login: string } | null;
  token: {
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: number | null;
    refreshTokenExpiresAt: number | null;
  } | null;
};

type PendingAuthorization = { expiresAt: number; codeVerifier: string };

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

type GitHubAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
  githubConnection: GitHubConnection;
};

const apiVersion = "2026-03-10";
const authorizationLifetimeMs = 10 * 60 * 1000;
const refreshBeforeExpiryMs = 60 * 1000;

export function createGitHubAuth({
  clientId,
  clientSecret,
  redirectUri,
  appUrl,
  fetchImpl = globalThis.fetch,
  githubConnection,
}: GitHubAuthOptions) {
  const pendingStates = new Map<string, PendingAuthorization>();
  const configured = Boolean(clientId && clientSecret);
  const settingsUrl = (outcome: string) => `${appUrl}/settings?github=${encodeURIComponent(outcome)}`;

  function startAuthorization(res: ServerResponse) {
    if (!configured) {
      redirect(res, settingsUrl("unconfigured"));
      return;
    }

    const state = randomBytes(32).toString("hex");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    pendingStates.set(state, { expiresAt: Date.now() + authorizationLifetimeMs, codeVerifier });

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "offline_access");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    redirect(res, url.toString());
  }

  async function handleCallback(url: URL, res: ServerResponse) {
    const state = url.searchParams.get("state") ?? "";
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");

    if (error || !code || !pending || pending.expiresAt < Date.now()) {
      redirect(res, settingsUrl(error ? "denied" : pending ? "invalid_state" : "error"));
      return;
    }

    try {
      const token = await requestToken({
        client_id: clientId!,
        client_secret: clientSecret!,
        code,
        redirect_uri: redirectUri,
        code_verifier: pending.codeVerifier,
      });
      const profile = await getProfile(token.accessToken);

      githubConnection.connected = true;
      githubConnection.connectedAt = new Date().toISOString();
      githubConnection.user = profile;
      githubConnection.token = token;
      redirect(res, settingsUrl("connected"));
    } catch (cause) {
      console.error("GitHub OAuth callback failed:", cause instanceof Error ? cause.message : "Unknown error");
      redirect(res, settingsUrl("error"));
    }
  }

  async function getAccessToken(): Promise<string> {
    const token = githubConnection.token;
    if (!githubConnection.connected || !token) {
      throw new Error("GitHub is not connected. Connect GitHub in Settings.");
    }
    if (!token.accessTokenExpiresAt || token.accessTokenExpiresAt > Date.now() + refreshBeforeExpiryMs) {
      return token.accessToken;
    }
    if (!token.refreshToken || (token.refreshTokenExpiresAt && token.refreshTokenExpiresAt <= Date.now())) {
      reset();
      throw new Error("GitHub authorization expired. Reconnect GitHub in Settings.");
    }

    try {
      const refreshed = await requestToken({
        client_id: clientId!,
        client_secret: clientSecret!,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      });
      githubConnection.token = {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? token.refreshToken,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt ?? token.refreshTokenExpiresAt,
      };
      return githubConnection.token.accessToken;
    } catch {
      reset();
      throw new Error("GitHub authorization expired. Reconnect GitHub in Settings.");
    }
  }

  async function requestToken(parameters: Record<string, string>): Promise<NonNullable<GitHubConnection["token"]>> {
    if (!clientId || !clientSecret) throw new Error("GitHub OAuth is not configured.");
    const response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    });
    const result = await response.json() as TokenResponse;
    if (!response.ok || !result.access_token) {
      throw new Error(result.error_description ?? result.error ?? "GitHub token exchange failed.");
    }

    const now = Date.now();
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? null,
      accessTokenExpiresAt: typeof result.expires_in === "number" ? now + result.expires_in * 1000 : null,
      refreshTokenExpiresAt: typeof result.refresh_token_expires_in === "number" ? now + result.refresh_token_expires_in * 1000 : null,
    };
  }

  async function getProfile(accessToken: string): Promise<{ id: number; login: string }> {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": apiVersion,
      },
    });
    if (!response.ok) throw new Error("GitHub could not confirm the signed-in user.");
    const user = await response.json() as { id?: number; login?: string };
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new Error("GitHub returned an unexpected user profile.");
    }
    return { id: user.id, login: user.login };
  }

  function reset() {
    githubConnection.connected = false;
    githubConnection.enabled = false;
    githubConnection.connectedAt = null;
    githubConnection.user = null;
    githubConnection.token = null;
  }

  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [state, pending] of pendingStates) {
      if (pending.expiresAt < now) pendingStates.delete(state);
    }
  }, 60_000);
  if (cleaner.unref) cleaner.unref();

  return { configured, startAuthorization, handleCallback, getAccessToken, reset };
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}
