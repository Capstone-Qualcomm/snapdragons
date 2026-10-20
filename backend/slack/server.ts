import { pathToFileURL } from "node:url";
import { createSlackApi } from "./slack-api.ts";
import { createSlackAuth } from "./slack-auth.ts";
import type { SlackConnection } from "./slack-auth.ts";
import { createSourceActivity } from "../source-activity.mts";
import { createSessions } from "../sessions.mts";
import { createSourceServer } from "../source-server.mts";

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
    async routes(req, res, url, { auth }) {
      if (req.method === "GET" && url.pathname === "/auth/slack/start") {
        auth.startAuthorization(res);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/auth/slack/callback") {
        await auth.handleCallback(url, res);
        return true;
      }
      return false;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createSlackServer();
}
