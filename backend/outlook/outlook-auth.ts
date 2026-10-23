import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createPendingStates, redirect } from "../source-server.mts";

export type OutlookToken = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

export type OutlookConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  user: { id: string; name: string | null; email: string | null } | null;
  token: OutlookToken | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type OutlookAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  redirectUri: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
  outlookConnection: OutlookConnection;
};

const refreshBeforeExpiryMs = 60_000;
const defaultScopes = "openid profile email offline_access User.Read Mail.Read";

export function createOutlookAuth({
  clientId,
  clientSecret,
  tenantId = "common",
  redirectUri,
  appUrl,
  fetchImpl = globalThis.fetch,
  outlookConnection,
}: OutlookAuthOptions) {
  const pendingStates = createPendingStates<{ codeVerifier: string }>();
  const configured = Boolean(clientId && clientSecret);
  const scopes = (process.env.OUTLOOK_SCOPES ?? defaultScopes).trim();
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
  const returnUrl = (outcome: string) => `${appUrl}/today?outlook=${encodeURIComponent(outcome)}`;

  function startAuthorization(res: ServerResponse) {
    if (!configured) {
      redirect(res, returnUrl("unconfigured"));
      return;
    }

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = pendingStates.add({ codeVerifier });
    const url = new URL(`${authority}/authorize`);
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    redirect(res, url.toString());
  }

  async function handleCallback(url: URL, res: ServerResponse) {
    const pending = pendingStates.take(url.searchParams.get("state") ?? "");
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (!pending) {
      redirect(res, returnUrl("invalid_state"));
      return;
    }
    if (error || !code) {
      redirect(res, returnUrl(error === "access_denied" ? "denied" : "error"));
      return;
    }

    try {
      const token = await requestToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: pending.codeVerifier,
        scope: scopes,
      });
      const user = await getProfile(token.accessToken);
      outlookConnection.connected = true;
      outlookConnection.enabled = true;
      outlookConnection.connectedAt = new Date().toISOString();
      outlookConnection.user = user;
      outlookConnection.token = token;
      redirect(res, returnUrl("connected"));
    } catch (cause) {
      console.error("Outlook OAuth callback failed:", cause instanceof Error ? cause.message : "Unknown error");
      redirect(res, returnUrl("error"));
    }
  }

  async function getAccessToken(): Promise<string> {
    const token = outlookConnection.token;
    if (!outlookConnection.connected || !token) throw new Error("Outlook is not connected. Connect Outlook.");
    if (token.accessTokenExpiresAt > Date.now() + refreshBeforeExpiryMs) return token.accessToken;
    if (!token.refreshToken) {
      reset();
      throw new Error("Outlook authorization expired. Reconnect Outlook.");
    }

    try {
      const refreshed = await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken, scope: scopes });
      if (outlookConnection.token !== token || !outlookConnection.connected) {
        throw new Error("Outlook connection changed during token refresh. Please retry.");
      }
      const next = { ...refreshed, refreshToken: refreshed.refreshToken || token.refreshToken };
      outlookConnection.token = next;
      return next.accessToken;
    } catch (error) {
      if (outlookConnection.token !== token || !outlookConnection.connected) {
        throw new Error("Outlook connection changed during token refresh. Please retry.");
      }
      reset();
      if (error instanceof Error && error.message.includes("connection changed")) throw error;
      throw new Error("Outlook authorization expired. Reconnect Outlook.");
    }
  }

  async function requestToken(parameters: Record<string, string>): Promise<OutlookToken> {
    if (!clientId || !clientSecret) throw new Error("Outlook OAuth is not configured.");
    const response = await fetchImpl(`${authority}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
    });
    const result = await response.json() as TokenResponse;
    if (!response.ok || !result.access_token) {
      throw new Error(result.error_description ?? result.error ?? "Outlook token request failed.");
    }
    if (parameters.grant_type === "authorization_code" && !result.refresh_token) {
      throw new Error("Microsoft did not return a refresh token. Check that offline_access is requested.");
    }
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? "",
      accessTokenExpiresAt: Date.now() + Math.max(0, (result.expires_in ?? 3600) - 60) * 1000,
    };
  }

  async function getProfile(accessToken: string): Promise<NonNullable<OutlookConnection["user"]>> {
    const response = await fetchImpl("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error("Outlook could not confirm the signed-in user.");
    const profile = await response.json() as { id?: unknown; displayName?: unknown; mail?: unknown; userPrincipalName?: unknown };
    if (typeof profile.id !== "string") throw new Error("Microsoft Graph returned an unexpected user profile.");
    return {
      id: profile.id,
      name: typeof profile.displayName === "string" ? profile.displayName : null,
      email: typeof profile.mail === "string" ? profile.mail : typeof profile.userPrincipalName === "string" ? profile.userPrincipalName : null,
    };
  }

  function reset() {
    outlookConnection.connected = false;
    outlookConnection.enabled = false;
    outlookConnection.connectedAt = null;
    outlookConnection.user = null;
    outlookConnection.token = null;
  }

  return { configured, startAuthorization, handleCallback, getAccessToken, reset };
}
