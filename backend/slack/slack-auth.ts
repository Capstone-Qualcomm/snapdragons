import type { ServerResponse } from "node:http";
import { createPendingStates, redirect } from "../source-server.mts";

export type SlackConnection = {
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  userId: string | null;
  team: { id: string; name: string } | null;
  token: { accessToken: string } | null;
};

type SlackAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  appUrl: string;
  fetchImpl: typeof fetch;
  slackConnection: SlackConnection;
};

const userScopes = "search:read,im:read,im:history,users:read";

export function createSlackAuth({ clientId, clientSecret, redirectUri, appUrl, fetchImpl, slackConnection }: SlackAuthOptions) {
  const pendingStates = createPendingStates();
  const configured = Boolean(clientId && clientSecret);
  const settingsUrl = (outcome: string) => `${appUrl}/settings?slack=${encodeURIComponent(outcome)}`;

  function startAuthorization(res: ServerResponse) {
    if (!configured) {
      redirect(res, settingsUrl("unconfigured"));
      return;
    }
    const state = pendingStates.add({});
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("user_scope", userScopes);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    redirect(res, url.toString());
  }

  async function handleCallback(url: URL, res: ServerResponse) {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!pendingStates.take(url.searchParams.get("state") ?? "")) {
      redirect(res, settingsUrl("invalid_state"));
      return;
    }
    if (error || !code) {
      redirect(res, settingsUrl(error === "access_denied" ? "denied" : "error"));
      return;
    }
    try {
      const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!result.ok || !(result.authed_user as Record<string, unknown>)?.access_token) {
        throw new Error(String(result.error ?? "Slack token request failed."));
      }
      const authedUser = result.authed_user as Record<string, unknown>;
      const team = result.team as Record<string, unknown> | undefined;
      slackConnection.connected = true;
      slackConnection.enabled = true;
      slackConnection.connectedAt = new Date().toISOString();
      slackConnection.userId = String(authedUser.id ?? "");
      slackConnection.team = team ? { id: String(team.id ?? ""), name: String(team.name ?? "") } : null;
      slackConnection.token = { accessToken: String(authedUser.access_token) };
      redirect(res, settingsUrl("connected"));
    } catch (cause) {
      console.error("Slack OAuth callback failed:", cause);
      redirect(res, settingsUrl("error"));
    }
  }

  function reset() {
    slackConnection.connected = false;
    slackConnection.enabled = false;
    slackConnection.connectedAt = null;
    slackConnection.userId = null;
    slackConnection.team = null;
    slackConnection.token = null;
  }

  return { configured, startAuthorization, handleCallback, reset };
}
