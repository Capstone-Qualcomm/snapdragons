import { pathToFileURL } from "node:url";
import type { NotionConnection } from "./notion-auth.ts";
import { createNotionAuth } from "./notion-auth.ts";
import { createNotionApi } from "./notion-api.ts";
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

export function createNotionServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.NOTION_PORT ?? 3007);
  const clientId = options.clientId ?? process.env.NOTION_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.NOTION_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? process.env.NOTION_REDIRECT_URI ?? `http://localhost:${port}/auth/notion/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const sessions = createSessions("notion", (saved?: NotionConnection) => {
    const connection: NotionConnection = saved ?? {
      connected: false,
      enabled: false,
      connectedAt: null,
      token: null,
      workspaceId: null,
      workspaceName: null,
      workspaceIcon: null,
      botId: null,
      owner: null,
    };
    const auth = createNotionAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, notionConnection: connection });
    const notionApi = createNotionApi({ notionConnection: connection, fetchImpl, getAccessToken: auth.getAccessToken });
    return { connection, auth, notionApi, activity: createSourceActivity() };
  }, (session) => session.connection);

  return createSourceServer({
    name: "notion",
    title: "Notion",
    port,
    appUrl,
    session: sessions.get,
    status: ({ connection, auth }) => ({
      configured: auth.configured,
      connected: connection.connected,
      enabled: connection.enabled,
      connectedAt: connection.connectedAt,
      workspace: connection.workspaceName,
      user: typeof connection.owner?.user === "object" && connection.owner.user
        ? (connection.owner.user as Record<string, unknown>).name ?? null
        : null,
    }),
    // Search returns only page metadata; page contents stay out of this source list.
    items: "pages",
    loadItems: ({ notionApi }) => notionApi.getPages(),
    async routes(_req, res, url, { auth }) {
      if (_req.method === "GET" && url.pathname === "/auth/notion/start") {
        auth.start(res);
        return true;
      }
      if (_req.method === "GET" && url.pathname === "/auth/notion/callback") {
        await auth.handleCallback(url, res);
        return true;
      }
      return false;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createNotionServer();
}
