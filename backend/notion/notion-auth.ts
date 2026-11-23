import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createPendingStates, redirect } from "../source-server.mts";

export type NotionConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  ownerName: string | null;
  token: string | null;
};

type NotionAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
  connection: NotionConnection;
};

type TokenResponse = {
  access_token?: string;
  workspace_id?: string;
  workspace_name?: string;
  owner?: { user?: { name?: string } };
  error?: string;
};

export function createNotionAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl = globalThis.fetch, connection }: NotionAuthOptions) {
  const pendingStates = createPendingStates();
  const configured = Boolean(clientId && clientSecret);
  const returnUrl = (outcome: string) => `${appUrl}/connections?notion=${encodeURIComponent(outcome)}`;

  function startAuthorization(res: ServerResponse) {
    if (!configured) {
      redirect(res, returnUrl("unconfigured"));
      return;
    }
    const state = pendingStates.add({});
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    redirect(res, url.toString());
  }

  async function handleCallback(url: URL, res: ServerResponse) {
    const state = url.searchParams.get("state") ?? "";
    if (!pendingStates.take(state)) {
      redirect(res, returnUrl("invalid_state"));
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      redirect(res, returnUrl(error === "access_denied" ? "denied" : "error"));
      return;
    }
    try {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const response = await fetchImpl("https://api.notion.com/v1/oauth/token", {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
      });
      const result = await response.json() as TokenResponse;
      if (!response.ok || !result.access_token) throw new Error(result.error ?? "Notion token exchange failed.");
      connection.connected = true;
      connection.enabled = true;
      connection.connectedAt = new Date().toISOString();
      connection.workspaceId = result.workspace_id ?? null;
      connection.workspaceName = result.workspace_name ?? null;
      connection.ownerName = result.owner?.user?.name ?? null;
      connection.token = result.access_token;
      redirect(res, returnUrl("connected"));
    } catch (cause) {
      console.error("Notion OAuth callback failed:", cause instanceof Error ? cause.message : "Unknown error");
      redirect(res, returnUrl("error"));
    }
  }

  function reset() {
    connection.connected = false;
    connection.enabled = false;
    connection.connectedAt = null;
    connection.workspaceId = null;
    connection.workspaceName = null;
    connection.ownerName = null;
    connection.token = null;
  }

  return { configured, startAuthorization, handleCallback, reset };
}
