import { randomBytes } from "node:crypto";
import { getOrCreateSession, readSession } from "../../core/session.mjs";
import { json, readJson, redirect } from "../../core/http.mjs";
import { authorizationUrl, completeAuthorization, connectionSummary, getMessagesForSession, setConnectionEnabled, slackOAuthConfigured, store } from "./slack.mjs";

const pendingAuthorizations = new Map();

function settingsRedirect(outcome) {
  return `/settings?slack=${encodeURIComponent(outcome)}`;
}

async function handleApi(request, response, pathname) {
  const sessionId = getOrCreateSession(request, response);

  if (request.method === "GET" && pathname === "/api/slack/connection") {
    json(response, 200, { slack: await connectionSummary(sessionId) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/slack/messages") {
    try {
      json(response, 200, { messages: await getMessagesForSession(sessionId) });
    } catch (error) {
      json(response, 409, { error: error instanceof Error ? error.message : "Could not load Slack messages." });
    }
    return true;
  }

  if (request.method !== "POST" || !request.headers["x-requested-with"]) return false;

  try {
    const body = await readJson(request);
    if (pathname === "/api/slack/connection/enabled" && typeof body.enabled === "boolean") {
      await setConnectionEnabled(sessionId, body.enabled);
    } else if (pathname === "/api/slack/connection/disconnect") {
      await store.removeConnection(sessionId);
    } else {
      json(response, 400, { error: "Invalid Slack connection request." });
      return true;
    }
    json(response, 200, { slack: await connectionSummary(sessionId) });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Could not update the Slack connection." });
  }
  return true;
}

export async function handleSlackRequest(request, response, url) {
  if (url.pathname.startsWith("/api/slack/")) {
    return handleApi(request, response, url.pathname);
  }

  if (request.method === "GET" && url.pathname === "/auth/slack/start") {
    if (!slackOAuthConfigured()) {
      redirect(response, settingsRedirect("unconfigured"));
      return true;
    }
    const sessionId = getOrCreateSession(request, response);
    const state = randomBytes(32).toString("hex");
    pendingAuthorizations.set(state, { sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
    redirect(response, authorizationUrl(state).toString());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/auth/slack/callback") {
    const state = url.searchParams.get("state");
    const pending = state ? pendingAuthorizations.get(state) : null;
    if (state) pendingAuthorizations.delete(state);
    if (!pending || pending.expiresAt < Date.now() || readSession(request) !== pending.sessionId) {
      redirect(response, settingsRedirect("invalid_state"));
      return true;
    }
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) {
      redirect(response, settingsRedirect(url.searchParams.has("error") ? "denied" : "error"));
      return true;
    }
    try {
      await completeAuthorization(pending.sessionId, code);
      redirect(response, settingsRedirect("connected"));
    } catch (error) {
      console.error("Slack OAuth callback failed:", error);
      redirect(response, settingsRedirect("error"));
    }
    return true;
  }

  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [state, pending] of pendingAuthorizations) {
    if (pending.expiresAt < now) pendingAuthorizations.delete(state);
  }
}, 60_000).unref();
