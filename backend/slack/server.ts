import { pathToFileURL } from "node:url";
import { createSlackApi } from "./slack-api.ts";
import { createSlackAuth } from "./slack-auth.ts";
import type { SlackConnection } from "./slack-auth.ts";
import { createSourceActivity } from "../source-activity.mts";
import { createSessions } from "../sessions.mts";
import { createSourceServer, readJson, send } from "../source-server.mts";

type ServerOptions = {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  appUrl?: string;
  fetch?: typeof fetch;
};

export function createSlackServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.SLACK_PORT ?? 3002);
  const clientId = options.clientId ?? process.env.SLACK_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.SLACK_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? process.env.SLACK_REDIRECT_URI ?? `http://localhost:${port}/auth/slack/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const sessions = createSessions("slack", (saved?: SlackConnection) => {
    const connection: SlackConnection = saved ?? { connected: false, enabled: false, connectedAt: null, userId: null, team: null, token: null };
    const auth = createSlackAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, slackConnection: connection });
    const slackApi = createSlackApi({ slackConnection: connection, fetchImpl });
    return { connection, auth, slackApi, activity: createSourceActivity() };
  }, (session) => session.connection);

  return createSourceServer({
    name: "slack",
    title: "Slack",
    port,
    appUrl,
    session: sessions.get,
    status: ({ connection, auth }) => ({
      configured: auth.configured,
      connected: connection.connected,
      enabled: connection.enabled,
      connectedAt: connection.connectedAt,
      team: connection.team?.name ?? null,
    }),
    items: "messages",
    loadItems: ({ slackApi }) => slackApi.getMessages(),
    async routes(req, res, url, { auth, connection, slackApi }) {
      if (req.method === "GET" && url.pathname === "/auth/slack/start") {
        auth.startAuthorization(res);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/auth/slack/callback") {
        await auth.handleCallback(url, res);
        return true;
      }
      const contextPath = req.method === "GET" && url.pathname.match(/^\/api\/slack\/messages\/([^/]+)\/context$/);
      if (contextPath) {
        if (!connection.connected) { send(res, 401, { error: "Slack is not connected. Connect Slack." }); return true; }
        if (!connection.enabled) { send(res, 403, { error: "Slack is turned off. Turn it on in Connections." }); return true; }
        try {
          const id = decodeURIComponent(contextPath[1]);
          const separator = id.indexOf(":");
          if (separator < 1) throw new Error("Slack channel could not be identified.");
          send(res, 200, { messages: await slackApi.getContext(id.slice(0, separator)) });
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : "Could not load Slack messages." });
        }
        return true;
      }
      const messagePath = req.method === "POST" && url.pathname.match(/^\/api\/slack\/messages\/([^/]+)\/message$/);
      if (messagePath) {
        if (!connection.connected) { send(res, 401, { error: "Slack is not connected. Connect Slack." }); return true; }
        if (!connection.enabled) { send(res, 403, { error: "Slack is turned off. Turn it on in Connections." }); return true; }
        try {
          const id = decodeURIComponent(messagePath[1]);
          const separator = id.indexOf(":");
          const channel = id.slice(0, separator);
          const body = await readJson(req) as { text?: unknown };
          if (separator < 1) throw new Error("Slack channel could not be identified.");
          if (typeof body.text !== "string" || !body.text.trim()) throw new Error("Message must be text.");
          send(res, 200, await slackApi.sendMessage(channel, body.text.trim()));
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : "Could not send the Slack message." });
        }
        return true;
      }
      return false;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createSlackServer();
}
