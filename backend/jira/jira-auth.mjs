import { randomBytes } from "node:crypto";

export function createJiraAuth({ clientId, clientSecret, redirectUri, appUrl, scopes, fetchImpl, jiraConnection }) {
  const pendingStates = new Map();
  let refreshInFlight = null;
  const configured = Boolean(clientId && clientSecret);
  const settingsUrl = (outcome) => `${appUrl}/settings?jira=${encodeURIComponent(outcome)}`;

  function redirect(res, url) {
    res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
    res.end();
  }

  function start(res) {
    if (!configured) {
      redirect(res, settingsUrl("unconfigured"));
      return;
    }

    const state = randomBytes(32).toString("hex");
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);
    const authorizeUrl = new URL("https://auth.atlassian.com/authorize");
    authorizeUrl.search = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      prompt: "consent",
    }).toString();
    redirect(res, authorizeUrl.toString());
  }

  function saveToken(token) {
    jiraConnection.token = token;
    jiraConnection.tokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in ?? 3600) - 60) * 1000;
  }

  async function handleCallback(url, res) {
    const state = url.searchParams.get("state") ?? "";
    const expiresAt = pendingStates.get(state);
    pendingStates.delete(state);
    if (!expiresAt || expiresAt < Date.now()) {
      redirect(res, settingsUrl("invalid_state"));
      return;
    }
    if (url.searchParams.has("error")) {
      redirect(res, settingsUrl(url.searchParams.get("error") === "access_denied" ? "denied" : "error"));
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
      const sites = await resourcesResponse.json();
      Object.assign(jiraConnection, {
        connected: true,
        enabled: true,
        connectedAt: new Date().toISOString(),
        cloudId: sites[0]?.id ?? null,
        sites: sites.map(({ id, name, url: siteUrl }) => ({ id, name, url: siteUrl })),
        token: null,
      });
      saveToken(token);
      redirect(res, settingsUrl("connected"));
    } catch (error) {
      console.error("Jira OAuth callback failed:", error instanceof Error ? error.message : "unknown error");
      redirect(res, settingsUrl("error"));
    }
  }

  async function refreshAccessToken() {
    if (!jiraConnection.token?.refresh_token) {
      throw new Error("Jira authorization expired. Reconnect Jira in Settings.");
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
            refresh_token: jiraConnection.token.refresh_token,
          }),
        });
        if (!response.ok) throw new Error("Jira authorization expired. Reconnect Jira in Settings.");
        const token = await response.json();
        saveToken(token);
        return token.access_token;
      })();
    }
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getAccessToken(forceRefresh = false) {
    if (!jiraConnection.token?.access_token) {
      throw new Error("Jira is not connected. Connect Jira in Settings.");
    }
    if (forceRefresh || Date.now() >= (jiraConnection.tokenExpiresAt ?? 0)) return refreshAccessToken();
    return jiraConnection.token.access_token;
  }

  function reset() {
    Object.assign(jiraConnection, {
      connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null,
    });
    refreshInFlight = null;
  }

  return { configured, start, handleCallback, getAccessToken, reset };
}
