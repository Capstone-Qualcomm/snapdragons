import { randomBytes } from "node:crypto";
import { getOrCreateSession, readSession } from "../../core/session.mjs";
import { json, readJson, redirect } from "../../core/http.mjs";
import { removeConnection } from "./connection-store.mjs";
import { authorizationUrl, completeAuthorization, connectionSummary, getAssignedIssuesForSession, jiraOAuthConfigured, selectJiraSite, setConnectionEnabled } from "./oauth.mjs";

const pendingAuthorizations = new Map();

function settingsRedirect(outcome) {
  return `/settings?jira=${encodeURIComponent(outcome)}`;
}

async function handleApi(request, response, pathname) {
  const sessionId = getOrCreateSession(request, response);

  if (request.method === "GET" && pathname === "/api/jira/connection") {
    json(response, 200, { jira: await connectionSummary(sessionId) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/jira/issues") {
    try {
      json(response, 200, { issues: await getAssignedIssuesForSession(sessionId) });
    } catch (error) {
      json(response, 409, { error: error instanceof Error ? error.message : "Could not load Jira tasks." });
    }
    return true;
  }

  if (request.method !== "POST" || !request.headers["x-requested-with"]) return false;

  try {
    const body = await readJson(request);
    if (pathname === "/api/jira/connection/enabled" && typeof body.enabled === "boolean") {
      await setConnectionEnabled(sessionId, body.enabled);
    } else if (pathname === "/api/jira/connection/site" && typeof body.cloudId === "string") {
      await selectJiraSite(sessionId, body.cloudId);
    } else if (pathname === "/api/jira/connection/disconnect") {
      await removeConnection(sessionId);
    } else {
      json(response, 400, { error: "Invalid Jira connection request." });
      return true;
    }
    json(response, 200, { jira: await connectionSummary(sessionId) });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Could not update the Jira connection." });
  }
  return true;
}

export async function handleJiraRequest(request, response, url) {
  if (url.pathname.startsWith("/api/jira/")) {
    return handleApi(request, response, url.pathname);
  }

  if (request.method === "GET" && url.pathname === "/auth/jira/start") {
    if (!jiraOAuthConfigured()) {
      redirect(response, settingsRedirect("unconfigured"));
      return true;
    }
    try {
      const sessionId = getOrCreateSession(request, response);
      const state = randomBytes(32).toString("hex");
      pendingAuthorizations.set(state, { sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
      redirect(response, authorizationUrl(state).toString());
    } catch (error) {
      console.error("Could not start Jira authorization:", error);
      redirect(response, settingsRedirect("error"));
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/auth/jira/callback") {
    const state = url.searchParams.get("state");
    const pending = state ? pendingAuthorizations.get(state) : null;
    if (state) pendingAuthorizations.delete(state);
    if (!pending || pending.expiresAt < Date.now() || readSession(request) !== pending.sessionId) {
      redirect(response, settingsRedirect("invalid_state"));
      return true;
    }
    if (url.searchParams.has("error")) {
      redirect(response, settingsRedirect("denied"));
      return true;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      redirect(response, settingsRedirect("error"));
      return true;
    }
    try {
      await completeAuthorization(pending.sessionId, code);
      redirect(response, settingsRedirect("connected"));
    } catch (error) {
      console.error("Jira OAuth callback failed:", error);
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
