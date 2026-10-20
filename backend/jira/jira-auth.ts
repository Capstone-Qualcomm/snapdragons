import type { ServerResponse } from "node:http";
import { createPendingStates, redirect } from "../source-server.mts";

export type JiraSite = { id: string; name?: string; url?: string };
export type JiraToken = { access_token: string; refresh_token?: string; expires_in?: number };
export type JiraConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  cloudId: string | null;
  sites: JiraSite[];
  token: JiraToken | null;
  tokenExpiresAt?: number;
};

type JiraAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  appUrl: string;
  scopes: string;
  fetchImpl: typeof fetch;
  jiraConnection: JiraConnection;
};

export function createJiraAuth({ clientId, clientSecret, redirectUri, appUrl, scopes, fetchImpl, jiraConnection }: JiraAuthOptions) {
  const pendingStates = createPendingStates();
  let refreshInFlight: Promise<string> | null = null;
  const configured = Boolean(clientId && clientSecret);
  const returnUrl = (outcome: string) => `${appUrl}/today?jira=${encodeURIComponent(outcome)}`;

  function start(res: ServerResponse): void {
    if (!configured) {
      redirect(res, returnUrl("unconfigured"));
      return;
    }

    const state = pendingStates.add({});
    const authorizeUrl = new URL("https://auth.atlassian.com/authorize");
    authorizeUrl.search = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: clientId ?? "",
      scope: scopes,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      prompt: "consent",
    }).toString();
    redirect(res, authorizeUrl.toString());
  }

  function saveToken(token: JiraToken): void {
    jiraConnection.token = token;
    jiraConnection.tokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in ?? 3600) - 60) * 1000;
  }

  async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
    if (!pendingStates.take(url.searchParams.get("state") ?? "")) {
      redirect(res, returnUrl("invalid_state"));
      return;
    }
    if (url.searchParams.has("error")) {
      redirect(res, returnUrl(url.searchParams.get("error") === "access_denied" ? "denied" : "error"));
      return;
    }

    try {
      const tokenResponse = await fetchImpl("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code: url.searchParams.get("code"),
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenResponse.ok) throw new Error("Token exchange failed");
      const token = await tokenResponse.json();
      const resourcesResponse = await fetchImpl("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
      });
      if (!resourcesResponse.ok) throw new Error("Could not list Jira sites");
      const sites = await resourcesResponse.json() as JiraSite[];
      Object.assign(jiraConnection, {
        connected: true,
        enabled: true,
        connectedAt: new Date().toISOString(),
        cloudId: sites[0]?.id ?? null,
        sites: sites.map(({ id, name, url: siteUrl }) => ({ id, name, url: siteUrl })),
        token: null,
      });
      saveToken(token);
      redirect(res, returnUrl("connected"));
    } catch (error) {
      console.error("Jira OAuth callback failed:", error instanceof Error ? error.message : "unknown error");
      redirect(res, returnUrl("error"));
    }
  }

  async function refreshAccessToken(): Promise<string> {
    const refreshToken = jiraConnection.token?.refresh_token;
    if (!refreshToken) {
      throw new Error("Jira authorization expired. Reconnect Jira.");
    }
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const response = await fetchImpl("https://auth.atlassian.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
          }),
        });
        if (!response.ok) throw new Error("Jira authorization expired. Reconnect Jira.");
        const token = await response.json() as JiraToken;
        saveToken(token);
        return token.access_token;
      })();
    }
    try {
      if (!refreshInFlight) throw new Error("Jira authorization expired. Reconnect Jira.");
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getAccessToken(forceRefresh = false): Promise<string> {
    const accessToken = jiraConnection.token?.access_token;
    if (!accessToken) {
      throw new Error("Jira is not connected. Connect Jira.");
    }
    if (forceRefresh || Date.now() >= (jiraConnection.tokenExpiresAt ?? 0)) return refreshAccessToken();
    return accessToken;
  }

  function reset() {
    Object.assign(jiraConnection, {
      connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null,
    });
    refreshInFlight = null;
  }

  return { configured, start, handleCallback, getAccessToken, reset };
}
