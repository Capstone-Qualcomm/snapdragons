import { pathToFileURL } from "node:url";
import { createSourceActivity } from "../source-activity.mts";
import { createSessions } from "../sessions.mts";
import { createSourceServer, readJson, send } from "../source-server.mts";
import { createTeamsApi } from "./teams-api.ts";
import { createTeamsAuth } from "./teams-auth.ts";
import type { TeamsConnection } from "./teams-auth.ts";

type ServerOptions = { port?: number; clientId?: string; clientSecret?: string; tenantId?: string; redirectUri?: string; appUrl?: string; fetch?: typeof fetch };

export function createTeamsServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.TEAMS_PORT ?? 3006);
  const clientId = options.clientId ?? process.env.TEAMS_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.TEAMS_CLIENT_SECRET;
  const tenantId = options.tenantId ?? process.env.TEAMS_TENANT_ID ?? "common";
  const redirectUri = options.redirectUri ?? process.env.TEAMS_REDIRECT_URI ?? `http://localhost:${port}/auth/teams/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const sessions = createSessions("teams", (saved?: TeamsConnection) => {
    const connection: TeamsConnection = saved ?? { connected: false, enabled: false, connectedAt: null, user: null, token: null };
    const auth = createTeamsAuth({ clientId, clientSecret, tenantId, redirectUri, appUrl, fetchImpl, teamsConnection: connection });
    const teamsApi = createTeamsApi({ teamsConnection: connection, fetchImpl, getAccessToken: auth.getAccessToken });
    return { connection, auth, teamsApi, activity: createSourceActivity() };
  }, (session) => session.connection);

  return createSourceServer({
    name: "teams",
    title: "Teams",
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
    loadItems: ({ teamsApi }) => teamsApi.getMessages(),
    async routes(req, res, url, { auth, connection, teamsApi }) {
      if (req.method === "GET" && url.pathname === "/auth/teams/start") { auth.startAuthorization(res); return true; }
      if (req.method === "GET" && url.pathname === "/auth/teams/callback") { await auth.handleCallback(url, res); return true; }
      const messagePath = req.method === "POST" && url.pathname.match(/^\/api\/teams\/messages\/([^/]+)\/message$/);
      if (messagePath) {
        if (!connection.connected) { send(res, 401, { error: "Teams is not connected. Connect Teams." }); return true; }
        if (!connection.enabled) { send(res, 403, { error: "Teams is turned off. Turn it on in Connections." }); return true; }
        try {
          const id = decodeURIComponent(messagePath[1]);
          const separator = id.lastIndexOf(":");
          if (separator < 1) throw new Error("Teams chat could not be identified.");
          const body = await readJson(req) as { text?: unknown };
          if (typeof body.text !== "string" || !body.text.trim()) throw new Error("Message must be text.");
          send(res, 200, await teamsApi.sendMessage(id.slice(0, separator), body.text.trim()));
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : "Could not send the Teams message." });
        }
        return true;
      }
      return false;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) createTeamsServer();
