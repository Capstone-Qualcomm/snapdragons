import { pathToFileURL } from "node:url";
import { createSourceActivity } from "../source-activity.mts";
import { createSessions } from "../sessions.mts";
import { createSourceServer } from "../source-server.mts";
import { createOutlookApi } from "./outlook-api.ts";
import { createOutlookAuth } from "./outlook-auth.ts";
import type { OutlookConnection } from "./outlook-auth.ts";

type ServerOptions = {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  redirectUri?: string;
  appUrl?: string;
  fetch?: typeof fetch;
};

export function createOutlookServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.OUTLOOK_PORT ?? 3005);
  const clientId = options.clientId ?? process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.OUTLOOK_CLIENT_SECRET;
  const tenantId = options.tenantId ?? process.env.OUTLOOK_TENANT_ID ?? "common";
  const redirectUri = options.redirectUri ?? process.env.OUTLOOK_REDIRECT_URI ?? `http://localhost:${port}/auth/outlook/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const sessions = createSessions("outlook", (saved?: OutlookConnection) => {
    const connection: OutlookConnection = saved ?? { connected: false, enabled: false, connectedAt: null, user: null, token: null };
    const auth = createOutlookAuth({ clientId, clientSecret, tenantId, redirectUri, appUrl, fetchImpl, outlookConnection: connection });
    const outlookApi = createOutlookApi({ outlookConnection: connection, fetchImpl, getAccessToken: auth.getAccessToken });
    return { connection, auth, outlookApi, activity: createSourceActivity() };
  }, (session) => session.connection);

  return createSourceServer({
    name: "outlook",
    title: "Outlook",
    port,
    appUrl,
    session: sessions.get,
    status: ({ connection, auth }) => ({
      configured: auth.configured,
      connected: connection.connected,
      enabled: connection.enabled,
      connectedAt: connection.connectedAt,
      user: connection.user?.name ?? connection.user?.email ?? null,
      email: connection.user?.email ?? null,
    }),
    items: "messages",
    loadItems: ({ outlookApi }) => outlookApi.getUnreadMessages(),
    async routes(req, res, url, { auth }) {
      if (req.method === "GET" && url.pathname === "/auth/outlook/start") {
        auth.startAuthorization(res);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/auth/outlook/callback") {
        await auth.handleCallback(url, res);
        return true;
      }
      return false;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createOutlookServer();
}
