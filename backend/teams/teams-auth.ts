import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createPendingStates, redirect } from "../source-server.mts";

export type TeamsToken = { accessToken: string; refreshToken: string; accessTokenExpiresAt: number };
export type TeamsConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  user: { id: string; name: string | null; email: string | null } | null;
  token: TeamsToken | null;
};

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
type TeamsAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  redirectUri: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
  teamsConnection: TeamsConnection;
};

const scopesDefault = "openid profile email offline_access User.Read Chat.Read";
const refreshBeforeExpiryMs = 60_000;

export function createTeamsAuth({ clientId, clientSecret, tenantId = "common", redirectUri, appUrl, fetchImpl = globalThis.fetch, teamsConnection }: TeamsAuthOptions) {
  const pendingStates = createPendingStates<{ codeVerifier: string }>();
  const configured = Boolean(clientId && clientSecret);
  const scopes = (process.env.TEAMS_SCOPES ?? scopesDefault).trim();
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
  const returnUrl = (outcome: string) => `${appUrl}/today?teams=${encodeURIComponent(outcome)}`;

  function startAuthorization(res: ServerResponse) {
    if (!configured) { redirect(res, returnUrl("unconfigured")); return; }
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
    if (!pending) { redirect(res, returnUrl("invalid_state")); return; }
    if (error || !code) { redirect(res, returnUrl(error === "access_denied" ? "denied" : "error")); return; }
    try {
      const token = await requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: pending.codeVerifier, scope: scopes });
      const user = await getProfile(token.accessToken);
      teamsConnection.connected = true;
      teamsConnection.enabled = true;
      teamsConnection.connectedAt = new Date().toISOString();
      teamsConnection.user = user;
      teamsConnection.token = token;
      redirect(res, returnUrl("connected"));
    } catch (cause) {
      console.error("Teams OAuth callback failed:", cause instanceof Error ? cause.message : "Unknown error");
      redirect(res, returnUrl("error"));
    }
  }

  let refreshing: Promise<string> | null = null;
  async function getAccessToken(): Promise<string> {
    const token = teamsConnection.token;
    if (!teamsConnection.connected || !token) throw new Error("Teams is not connected. Connect Teams.");
    if (token.accessTokenExpiresAt > Date.now() + refreshBeforeExpiryMs) return token.accessToken;
    if (!token.refreshToken) { reset(); throw new Error("Teams authorization expired. Reconnect Teams."); }
    refreshing ??= refresh(token).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function refresh(token: TeamsToken): Promise<string> {
    let renewed: TeamsToken;
    try { renewed = await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken, scope: scopes }); }
    catch (error) {
      if (teamsConnection.token !== token || !teamsConnection.connected) throw new Error("Teams connection changed during token refresh. Please retry.");
      if ((error as { code?: string }).code !== "invalid_grant") throw new Error("Teams could not refresh the sign-in. Try again.");
      reset();
      throw new Error("Teams authorization expired. Reconnect Teams.");
    }
    if (teamsConnection.token !== token || !teamsConnection.connected) throw new Error("Teams connection changed during token refresh. Please retry.");
    teamsConnection.token = { ...renewed, refreshToken: renewed.refreshToken || token.refreshToken };
    return renewed.accessToken;
  }

  async function requestToken(parameters: Record<string, string>): Promise<TeamsToken> {
    if (!clientId || !clientSecret) throw new Error("Teams OAuth is not configured.");
    const response = await fetchImpl(`${authority}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
    });
    const result = await response.json() as TokenResponse;
    if (!response.ok || !result.access_token) throw Object.assign(new Error(result.error_description ?? result.error ?? "Teams token request failed."), { code: result.error });
    if (parameters.grant_type === "authorization_code" && !result.refresh_token) throw new Error("Microsoft did not return a refresh token. Check that offline_access is requested.");
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? "",
      accessTokenExpiresAt: Date.now() + Math.max(0, (result.expires_in ?? 3600) - 60) * 1000,
    };
  }

  async function getProfile(accessToken: string): Promise<NonNullable<TeamsConnection["user"]>> {
    const response = await fetchImpl("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error("Teams could not confirm the signed-in Microsoft user.");
    const profile = await response.json() as { id?: unknown; displayName?: unknown; mail?: unknown; userPrincipalName?: unknown };
    if (typeof profile.id !== "string") throw new Error("Microsoft Graph returned an unexpected user profile.");
    return {
      id: profile.id,
      name: typeof profile.displayName === "string" ? profile.displayName : null,
      email: typeof profile.mail === "string" ? profile.mail : typeof profile.userPrincipalName === "string" ? profile.userPrincipalName : null,
    };
  }

  function reset() {
    refreshing = null;
    teamsConnection.connected = false;
    teamsConnection.enabled = false;
    teamsConnection.connectedAt = null;
    teamsConnection.user = null;
    teamsConnection.token = null;
  }

  return { configured, startAuthorization, handleCallback, getAccessToken, reset };
}
