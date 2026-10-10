import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3001);
const clientId = process.env.ATLASSIAN_CLIENT_ID;
const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;
const redirectUri = process.env.ATLASSIAN_REDIRECT_URI ?? `http://localhost:${port}/auth/jira/callback`;
const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
const scopes = process.env.ATLASSIAN_SCOPES ?? "read:jira-work read:jira-user offline_access";
const pendingStates = new Map();

// This initial backend is a single-user local integration. Tokens stay out of
// the browser and are held in memory; durable, per-user storage belongs with
// the app's eventual authenticated backend/database.
let jiraConnection = { connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null };

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
  res.end();
}

function settingsUrl(outcome) {
  return `${appUrl}/settings?jira=${encodeURIComponent(outcome)}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/auth/jira/start") {
    if (!clientId || !clientSecret) {
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
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/jira/callback") {
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
      const tokenResponse = await fetch("https://auth.atlassian.com/oauth/token", {
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
      const resourcesResponse = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
      });
      if (!resourcesResponse.ok) throw new Error("Could not list Jira sites");
      const sites = await resourcesResponse.json();
      jiraConnection = {
        connected: true,
        enabled: true,
        connectedAt: new Date().toISOString(),
        cloudId: sites[0]?.id ?? null,
        sites: sites.map(({ id, name, url: siteUrl }) => ({ id, name, url: siteUrl })),
        token,
      };
      redirect(res, settingsUrl("connected"));
    } catch (error) {
      console.error("Jira OAuth callback failed:", error instanceof Error ? error.message : "unknown error");
      redirect(res, settingsUrl("error"));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jira/connection") {
    send(res, 200, {
      jira: {
        configured: Boolean(clientId && clientSecret),
        connected: jiraConnection.connected,
        enabled: jiraConnection.enabled,
        connectedAt: jiraConnection.connectedAt,
        cloudId: jiraConnection.cloudId,
        sites: jiraConnection.sites,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jira/connection/disconnect") {
    jiraConnection = { connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null };
    send(res, 200, { jira: { configured: Boolean(clientId && clientSecret), connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [] } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jira/connection/enabled") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let enabled;
    try {
      enabled = JSON.parse(body).enabled;
    } catch {
      send(res, 400, { error: "Invalid request body" });
      return;
    }
    if (typeof enabled !== "boolean" || (enabled && !jiraConnection.connected)) {
      send(res, 400, { error: "Jira must be connected before it can be enabled" });
      return;
    }
    jiraConnection.enabled = enabled;
    send(res, 200, { jira: { configured: Boolean(clientId && clientSecret), connected: jiraConnection.connected, enabled, connectedAt: jiraConnection.connectedAt, cloudId: jiraConnection.cloudId, sites: jiraConnection.sites } });
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(port, () => console.log(`SnapDragons backend listening on http://localhost:${port}`));
