import type { ServerResponse } from "node:http";
import { createPendingStates, redirect } from "../source-server.mts";

export type NotionToken = {
  access_token: string;
  refresh_token?: string;
  [key: string]: unknown;
};

export type NotionConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  token: NotionToken | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  botId: string | null;
  owner: Record<string, unknown> | null;
};

type NotionAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  appUrl: string;
  fetchImpl: typeof fetch;
  notionConnection: NotionConnection;
};

export function createNotionAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, notionConnection }: NotionAuthOptions) {
  const pendingStates = createPendingStates();
  const configured = Boolean(clientId && clientSecret);
  const returnUrl = (outcome: string) => `${appUrl}/today?notion=${encodeURIComponent(outcome)}`;

  function start(res: ServerResponse): void {
    if (!configured) {
      redirect(res, returnUrl("unconfigured"));
      return;
    }
    const state = pendingStates.add({});
    const authorizeUrl = new URL("https://api.notion.com/v1/oauth/authorize");
    authorizeUrl.search = new URLSearchParams({
      owner: "user",
      client_id: clientId!,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    }).toString();
    redirect(res, authorizeUrl.toString());
  }

  async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
    if (!pendingStates.take(url.searchParams.get("state") ?? "")) {
      redirect(res, returnUrl("invalid_state"));
      return;
    }
    if (url.searchParams.has("error") || !url.searchParams.get("code")) {
      redirect(res, returnUrl(url.searchParams.get("error") === "access_denied" ? "denied" : "error"));
      return;
    }

    try {
      const response = await fetchImpl("https://api.notion.com/v1/oauth/token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) throw new Error("Notion token exchange failed");
      const token = await response.json() as NotionToken & {
        workspace_id?: string;
        workspace_name?: string;
        workspace_icon?: string | null;
        bot_id?: string;
        owner?: Record<string, unknown>;
      };
      if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Notion did not return an access token");

      Object.assign(notionConnection, {
        connected: true,
        enabled: true,
        connectedAt: new Date().toISOString(),
        token,
        workspaceId: token.workspace_id ?? null,
        workspaceName: token.workspace_name ?? null,
        workspaceIcon: token.workspace_icon ?? null,
        botId: token.bot_id ?? null,
        owner: token.owner ?? null,
      });
      redirect(res, returnUrl("connected"));
    } catch (error) {
      console.error("Notion OAuth callback failed:", error instanceof Error ? error.message : "unknown error");
      redirect(res, returnUrl("error"));
    }
  }

  function reset(): void {
    Object.assign(notionConnection, {
      connected: false,
      enabled: false,
      connectedAt: null,
      token: null,
      workspaceId: null,
      workspaceName: null,
      workspaceIcon: null,
      botId: null,
      owner: null,
    });
  }

  return { configured, start, handleCallback, reset };
}
