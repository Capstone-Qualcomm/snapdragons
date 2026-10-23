import { pathToFileURL } from "node:url";
import { createGitHubApi } from "./github-api.ts";
import { createGitHubAuth } from "./github-auth.ts";
import type { GitHubConnection } from "./github-auth.ts";
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

export function createGitHubServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.GITHUB_PORT ?? 3004);
  const clientId = options.clientId ?? process.env.GITHUB_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = options.redirectUri ?? process.env.GITHUB_REDIRECT_URI ?? `http://localhost:${port}/auth/github/callback`;
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const sessions = createSessions("github", (saved?: GitHubConnection) => {
    const connection: GitHubConnection = saved ?? { connected: false, enabled: false, connectedAt: null, user: null, token: null };
    const auth = createGitHubAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, githubConnection: connection });
    return { connection, auth, activity: createSourceActivity() };
  }, (session) => session.connection);
  const githubApi = createGitHubApi({ fetchImpl });

  return createSourceServer({
    name: "github",
    title: "GitHub",
    port,
    appUrl,
    session: sessions.get,
    status: ({ connection, auth }) => ({
      configured: auth.configured,
      connected: connection.connected,
      enabled: connection.enabled,
      connectedAt: connection.connectedAt,
      user: connection.user?.login ?? null,
    }),
    items: "issues",
    loadItems: async ({ auth }) => githubApi.getAssignedOpenIssues(await auth.getAccessToken()),
    async routes(req, res, url, { auth, connection }) {
      if (req.method === "GET" && url.pathname === "/auth/github/start") {
        auth.startAuthorization(res);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/auth/github/callback") {
        await auth.handleCallback(url, res);
        return true;
      }
      const commentPath = req.method === "POST" && url.pathname.match(/^\/api\/github\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/);
      if (commentPath) {
        if (!connection.connected) {
          send(res, 401, { error: "GitHub is not connected. Connect GitHub." });
          return true;
        }
        try {
          const body = (await readJson(req)).body;
          const repository = `${decodeURIComponent(commentPath[1])}/${decodeURIComponent(commentPath[2])}`;
          const issueNumber = Number(commentPath[3]);
          const result = await githubApi.postComment(await auth.getAccessToken(), repository, issueNumber, body);
          if ("error" in result) {
            send(res, result.status, { error: result.error });
            return true;
          }
          send(res, 200, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not post the GitHub comment.";
          send(res, /not connected|authorization expired/i.test(message) ? 401 : 400, { error: message });
        }
        return true;
      }
      return false;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createGitHubServer();
}
