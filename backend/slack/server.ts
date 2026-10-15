import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createSlackApi } from "./slack-api.ts";
import { createSlackAuth } from "./slack-auth.ts";
import type { SlackConnection } from "./slack-auth.ts";
import { createSlackLogs } from "./slack-logs.ts";

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

  const slackConnection: SlackConnection = { connected: false, enabled: false, connectedAt: null, userId: null, team: null, token: null };
  const auth = createSlackAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, slackConnection });
  const slackApi = createSlackApi({ slackConnection, fetchImpl });
  const slackLogs = createSlackLogs();

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  function connectionStatus() {
    return {
      configured: auth.configured,
      connected: slackConnection.connected,
      enabled: slackConnection.enabled,
      connectedAt: slackConnection.connectedAt,
      team: slackConnection.team?.name ?? null,
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/api/slack/connection") {
        send(res, 200, { slack: connectionStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/slack/messages") {
        if (!slackConnection.connected) {
          send(res, 401, { error: "Slack is not connected. Connect Slack in Settings." });
          return;
        }
        if (!slackConnection.enabled) {
          send(res, 403, { error: "Slack is connected but disabled. Enable it in Settings to load messages." });
          return;
        }
        try {
          const messages = await slackApi.getMessages();
          slackLogs.add("GET", url.pathname, { count: messages.length });
          send(res, 200, { messages });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Slack could not load messages.";
          send(res, message.includes("Reconnect Slack") || message.includes("not connected") ? 401 : 502, { error: message });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/auth/slack/start") {
        auth.startAuthorization(res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/auth/slack/callback") {
        await auth.handleCallback(
          url.searchParams.get("state") ?? "",
          url.searchParams.get("code"),
          url.searchParams.get("error"),
          res,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/slack/connection/disconnect") {
        auth.reset();
        send(res, 200, { slack: connectionStatus() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/slack/connection/enabled") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let enabled: unknown;
        try {
          enabled = JSON.parse(body).enabled;
        } catch {
          send(res, 400, { error: "Invalid request body" });
          return;
        }
        if (typeof enabled !== "boolean" || (enabled && !slackConnection.connected)) {
          send(res, 400, { error: "Slack must be connected before it can be enabled" });
          return;
        }
        slackConnection.enabled = enabled;
        send(res, 200, { slack: connectionStatus() });
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) {
        send(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
      }
    }
  });

  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`SnapDragons Slack backend listening on http://localhost:${actualPort}`);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createSlackServer();
}