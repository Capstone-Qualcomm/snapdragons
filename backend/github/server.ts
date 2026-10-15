import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createGitHubApi } from "./github-api.ts";
import { createGitHubAuth } from "./github-auth.ts";
import { createSourceActivity } from "../source-activity.mts";

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
  const appOrigin = new URL(appUrl).origin;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const githubConnection = {
    connected: false,
    enabled: false,
    connectedAt: null as string | null,
    user: null as { id: number; login: string } | null,
    token: null as {
      accessToken: string;
      refreshToken: string | null;
      accessTokenExpiresAt: number | null;
      refreshTokenExpiresAt: number | null;
    } | null,
  };

  const auth = createGitHubAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, githubConnection });
  const githubApi = createGitHubApi({ fetchImpl });
  const activity = createSourceActivity();

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  function connectionStatus() {
    return {
      configured: auth.configured,
      connected: githubConnection.connected,
      enabled: githubConnection.enabled,
      connectedAt: githubConnection.connectedAt,
      user: githubConnection.user?.login ?? null,
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/auth/github/start") {
        auth.startAuthorization(res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/auth/github/callback") {
        await auth.handleCallback(url, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/github/connection") {
        send(res, 200, { github: connectionStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/github/activity") {
        send(res, 200, { events: activity.list() });
        return;
      }

      if (req.method === "POST" && ["/api/github/connection/disconnect", "/api/github/connection/enabled"].includes(url.pathname)) {
        const origin = req.headers.origin;
        let trustedOrigin = false;
        try {
          trustedOrigin = typeof origin === "string" && new URL(origin).origin === appOrigin;
        } catch {
          trustedOrigin = false;
        }
        if (!trustedOrigin) {
          send(res, 403, { error: "This request must come from the application." });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/github/issues") {
        if (!githubConnection.connected) {
          activity.add(401);
          send(res, 401, { error: "GitHub is not connected. Connect GitHub in Settings." });
          return;
        }
        if (!githubConnection.enabled) {
          activity.add(403);
          send(res, 403, { error: "GitHub is connected but disabled. Enable it in Settings to load issues." });
          return;
        }
        try {
          const accessToken = await auth.getAccessToken();
          const issues = await githubApi.getAssignedOpenIssues(accessToken);
          activity.add(200, issues.length);
          send(res, 200, { issues });
        } catch (error) {
          const message = error instanceof Error ? error.message : "GitHub could not load assigned issues.";
          const status = message.includes("Reconnect GitHub") || message.includes("not connected") ? 401 : 502;
          activity.add(status);
          send(res, status, { error: message });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/github/connection/disconnect") {
        auth.reset();
        send(res, 200, { github: connectionStatus() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/github/connection/enabled") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let enabled: unknown;
        try {
          enabled = JSON.parse(body).enabled;
        } catch {
          send(res, 400, { error: "Invalid request body" });
          return;
        }
        if (typeof enabled !== "boolean" || (enabled && !githubConnection.connected)) {
          send(res, 400, { error: "GitHub must be connected before it can be enabled." });
          return;
        }
        githubConnection.enabled = enabled;
        send(res, 200, { github: connectionStatus() });
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) {
        send(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
      }
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`SnapDragons GitHub backend listening on http://localhost:${actualPort}`);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createGitHubServer();
}
