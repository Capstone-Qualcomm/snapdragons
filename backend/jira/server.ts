import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createJiraApi } from "./jira-api.ts";
import { createJiraAuth } from "./jira-auth.ts";
import { createJiraLogs } from "./jira-logs.ts";

type ServerOptions = {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  appUrl?: string;
  scopes?: string;
  fetch?: typeof fetch;
};

export function createJiraServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3001);
  const clientId = options.clientId ?? process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.ATLASSIAN_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? process.env.ATLASSIAN_REDIRECT_URI ?? `http://localhost:${port}/auth/jira/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const scopes = options.scopes ?? process.env.ATLASSIAN_SCOPES ?? "read:jira-work read:jira-user write:jira-work offline_access";
  const fetchImpl = options.fetch ?? globalThis.fetch;

  // This starter is a single-user local integration. Credentials and tokens
  // stay on the server in memory and are cleared when it restarts.
  const jiraConnection = { connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null };
  const auth = createJiraAuth({ clientId, clientSecret, redirectUri, appUrl, scopes, fetchImpl, jiraConnection });
  const jiraApi = createJiraApi({ jiraConnection, fetchImpl, getAccessToken: auth.getAccessToken });
  const jiraLogs = createJiraLogs();

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  function connectionStatus() {
    return {
      configured: auth.configured,
      connected: jiraConnection.connected,
      enabled: jiraConnection.enabled,
      connectedAt: jiraConnection.connectedAt,
      cloudId: jiraConnection.cloudId,
      sites: jiraConnection.sites,
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/auth/jira/start") {
      auth.start(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/jira/callback") {
      await auth.handleCallback(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jira/connection") {
      const result = { jira: connectionStatus() };
      jiraLogs.add("GET", url.pathname, result);
      send(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jira/logs") {
      send(res, 200, { logs: jiraLogs.list() });
      return;
    }

    const transitionsPath = url.pathname.match(/^\/api\/jira\/issues\/([^/]+)\/transitions$/);
    if (req.method === "GET" && transitionsPath) {
      if (!jiraConnection.connected) {
        send(res, 401, { error: "Jira is not connected. Connect Jira in Settings." });
        return;
      }
      try {
        const issueKey = decodeURIComponent(transitionsPath[1]);
        const result = await jiraApi.getTransitions(issueKey);
        if ("error" in result) {
          send(res, result.status, { error: result.error });
          return;
        }
        jiraLogs.add("GET", url.pathname, result);
        send(res, 200, result);
      } catch (error) {
        send(res, 502, { error: error instanceof Error ? error.message : "Could not load Jira status transitions." });
      }
      return;
    }

    const issueEditPath = url.pathname.match(/^\/api\/jira\/issues\/([^/]+)$/);
    if (req.method === "POST" && issueEditPath) {
      if (!jiraConnection.connected) {
        send(res, 401, { error: "Jira is not connected. Connect Jira in Settings." });
        return;
      }
      try {
        const issueKey = decodeURIComponent(issueEditPath[1]);
        let body = "";
        for await (const chunk of req) body += chunk;
        const changes = JSON.parse(body);
        const result = await jiraApi.updateIssue(issueKey, changes);
        if ("error" in result) {
          send(res, result.status, { error: result.error });
          return;
        }
        jiraLogs.add("POST", url.pathname, { request: { issueKey, changes }, response: { ok: true } });
        send(res, 200, result);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : "Could not update the Jira issue." });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jira/issues") {
      if (!jiraConnection.connected) {
        send(res, 401, { error: "Jira is not connected. Connect Jira in Settings." });
        return;
      }
      if (!jiraConnection.enabled) {
        send(res, 403, { error: "Jira is connected but disabled. Enable it in Settings to load tasks." });
        return;
      }
      try {
        const issues = await jiraApi.getAssignedIssues();
        jiraLogs.add("GET", url.pathname, { issues });
        send(res, 200, { issues });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Jira could not load assigned issues. Please try again.";
        send(res, message.includes("Reconnect Jira") || message.includes("not connected") ? 401 : 502, { error: message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jira/connection/disconnect") {
      auth.reset();
      send(res, 200, { jira: connectionStatus() });
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
      send(res, 200, { jira: connectionStatus() });
      return;
    }

    send(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`SnapDragons backend listening on http://localhost:${actualPort}`);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createJiraServer();
}
