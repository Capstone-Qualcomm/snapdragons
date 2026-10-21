import type { ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createJiraApi } from "./jira-api.ts";
import { createJiraAuth } from "./jira-auth.ts";
import type { JiraConnection } from "./jira-auth.ts";
import { createJiraLogs } from "./jira-logs.ts";
import { createSourceActivity } from "../source-activity.mts";
import { createSessions } from "../sessions.mts";
import { createSourceServer, readJson, send } from "../source-server.mts";

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

  // Each browser gets its own Jira connection. Credentials and tokens stay on
  // the server and connected ones are saved in .data so a restart keeps them.
  const sessions = createSessions("jira", (saved?: JiraConnection) => {
    const connection: JiraConnection = saved ?? { connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null };
    const auth = createJiraAuth({ clientId, clientSecret, redirectUri, appUrl, scopes, fetchImpl, jiraConnection: connection });
    const jiraApi = createJiraApi({ jiraConnection: connection, fetchImpl, getAccessToken: auth.getAccessToken });
    return { connection, auth, jiraApi, jiraLogs: createJiraLogs(), activity: createSourceActivity() };
  }, (session) => session.connection);

  return createSourceServer({
    name: "jira",
    title: "Jira",
    port,
    appUrl,
    session: sessions.get,
    status: ({ connection, auth }) => ({
      configured: auth.configured,
      connected: connection.connected,
      enabled: connection.enabled,
      connectedAt: connection.connectedAt,
      cloudId: connection.cloudId,
      sites: connection.sites,
    }),
    onConnection: ({ jiraLogs }, result) => jiraLogs.add("GET", "/api/jira/connection", result),
    items: "issues",
    async loadItems({ jiraApi, jiraLogs }) {
      const issues = await jiraApi.getAssignedIssues();
      jiraLogs.add("GET", "/api/jira/issues", { issues });
      return issues;
    },
    async routes(req, res, url, { connection, auth, jiraApi, jiraLogs }) {
      if (req.method === "GET" && url.pathname === "/auth/jira/start") {
        auth.start(res);
        return true;
      }

      if (req.method === "GET" && url.pathname === "/auth/jira/callback") {
        await auth.handleCallback(url, res);
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/jira/logs") {
        send(res, 200, { logs: jiraLogs.list() });
        return true;
      }

      const transitionsPath = req.method === "GET" && url.pathname.match(/^\/api\/jira\/issues\/([^/]+)\/transitions$/);
      if (transitionsPath) {
        if (!connection.connected) return notConnected(res);
        try {
          const result = await jiraApi.getTransitions(decodeURIComponent(transitionsPath[1]));
          if ("error" in result) {
            send(res, result.status, { error: result.error });
            return true;
          }
          jiraLogs.add("GET", url.pathname, result);
          send(res, 200, result);
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : "Could not load Jira status transitions." });
        }
        return true;
      }

      const issueEditPath = req.method === "POST" && url.pathname.match(/^\/api\/jira\/issues\/([^/]+)$/);
      if (issueEditPath) {
        if (!connection.connected) return notConnected(res);
        try {
          const issueKey = decodeURIComponent(issueEditPath[1]);
          const changes = await readJson(req);
          const result = await jiraApi.updateIssue(issueKey, changes);
          if ("error" in result) {
            send(res, result.status, { error: result.error });
            return true;
          }
          jiraLogs.add("POST", url.pathname, { request: { issueKey, changes }, response: { ok: true } });
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : "Could not update the Jira issue." });
        }
        return true;
      }

      return false;
    },
  });
}

function notConnected(res: ServerResponse) {
  send(res, 401, { error: "Jira is not connected. Connect Jira." });
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createJiraServer();
}
