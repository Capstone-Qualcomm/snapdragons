import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createNotionApi } from "./notion-api.ts";
import { createNotionAuth } from "./notion-auth.ts";
import type { NotionConnection } from "./notion-auth.ts";
import { createSessions } from "../sessions.mts";
import { readJson, send } from "../source-server.mts";

type ServerOptions = { port?: number; clientId?: string; clientSecret?: string; redirectUri?: string; appUrl?: string; fetch?: typeof fetch };

export function createNotionServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.NOTION_PORT ?? 3007);
  const clientId = options.clientId ?? process.env.NOTION_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.NOTION_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? process.env.NOTION_REDIRECT_URI ?? `http://localhost:${port}/auth/notion/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const appOrigin = new URL(appUrl).origin;
  const sessions = createSessions("notion", (saved?: NotionConnection) => {
    const connection: NotionConnection = saved ?? { connected: false, enabled: false, connectedAt: null, workspaceId: null, workspaceName: null, ownerName: null, token: null };
    const auth = createNotionAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, connection });
    return { connection, auth, notionApi: createNotionApi({ connection, fetchImpl }) };
  }, (session) => session.connection);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const session = sessions.get(req, res);
      const { connection, auth, notionApi } = session;
      const route = `${req.method} ${url.pathname}`;
      if (req.method === "POST" && req.headers.origin !== appOrigin) {
        send(res, 403, { error: "This request must come from the application." });
        return;
      }
      if (route === "GET /auth/notion/start") return auth.startAuthorization(res);
      if (route === "GET /auth/notion/callback") return await auth.handleCallback(url, res);
      if (route === "GET /api/notion/connection") {
        send(res, 200, { notion: { configured: auth.configured, connected: connection.connected, enabled: connection.enabled, connectedAt: connection.connectedAt, workspace: connection.workspaceName, user: connection.ownerName } });
        return;
      }
      if (route === "POST /api/notion/connection/enabled") {
        let body: Record<string, unknown>;
        try { body = await readJson(req); } catch { send(res, 400, { error: "Invalid request body." }); return; }
        if (typeof body.enabled !== "boolean" || (body.enabled && !connection.connected)) {
          send(res, 400, { error: "Notion must be connected before it can be turned on." });
          return;
        }
        connection.enabled = body.enabled;
        send(res, 200, { notion: { configured: auth.configured, connected: connection.connected, enabled: connection.enabled, connectedAt: connection.connectedAt, workspace: connection.workspaceName, user: connection.ownerName } });
        return;
      }
      if (route === "POST /api/notion/connection/disconnect") {
        auth.reset();
        send(res, 200, { notion: { configured: auth.configured, connected: false, enabled: false, connectedAt: null, workspace: null, user: null } });
        return;
      }
      if (route === "POST /api/notion/search") {
        if (!connection.connected) { send(res, 401, { error: "Notion is not connected. Connect Notion." }); return; }
        if (!connection.enabled) { send(res, 403, { error: "Notion is turned off. Turn it on in Connections." }); return; }
        let body: Record<string, unknown>;
        try { body = await readJson(req); } catch { send(res, 400, { error: "Invalid request body." }); return; }
        if (typeof body.query !== "string" || !body.query.trim()) { send(res, 400, { error: "Enter a question to search Notion." }); return; }
        try {
          send(res, 200, { pages: await notionApi.searchPages(body.query) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Notion could not load pages.";
          const status = /not connected|Reconnect Notion/.test(message) ? 401 : /turned off|denied access/.test(message) ? 403 : 502;
          send(res, status, { error: message });
        }
        return;
      }
      send(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : "Internal server error." });
    }
  });

  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => console.log(`Notion backend listening on http://${host}:${(server.address() as AddressInfo).port}`));
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) createNotionServer();
