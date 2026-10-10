import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3001);
const clientId = process.env.ATLASSIAN_CLIENT_ID;
const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;
const redirectUri = process.env.ATLASSIAN_REDIRECT_URI ?? `http://localhost:${port}/auth/jira/callback`;
const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
const scopes = process.env.ATLASSIAN_SCOPES ?? "read:jira-work read:jira-user write:jira-work offline_access";
const pendingStates = new Map();

// This initial backend is a single-user local integration. Tokens stay out of
// the browser and are held in memory; durable, per-user storage belongs with
// the app's eventual authenticated backend/database.
let jiraConnection = { connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null };
let refreshInFlight = null;
let customFieldCache = { expiresAt: 0, sprintId: null, storyPointsId: null };
const jiraLogs = [];

function addJiraLog(method, path, values) {
  jiraLogs.unshift({ id: randomBytes(8).toString("hex"), timestamp: new Date().toISOString(), node: "Q-01", method, path, values });
  if (jiraLogs.length > 100) jiraLogs.length = 100;
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
  res.end();
}

function settingsUrl(outcome) {
  return `${appUrl}/settings?jira=${encodeURIComponent(outcome)}`;
}

function saveToken(token) {
  jiraConnection.token = token;
  jiraConnection.tokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in ?? 3600) - 60) * 1000;
}

async function refreshAccessToken() {
  if (!jiraConnection.token?.refresh_token) {
    throw new Error("Jira authorization expired. Reconnect Jira in Settings.");
  }
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const response = await fetch("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: jiraConnection.token.refresh_token,
        }),
      });
      if (!response.ok) throw new Error("Jira authorization expired. Reconnect Jira in Settings.");
      const token = await response.json();
      saveToken(token);
      return token.access_token;
    })();
  }
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function getAccessToken(forceRefresh = false) {
  if (!jiraConnection.token?.access_token) {
    throw new Error("Jira is not connected. Connect Jira in Settings.");
  }
  if (forceRefresh || Date.now() >= (jiraConnection.tokenExpiresAt ?? 0)) {
    return refreshAccessToken();
  }
  return jiraConnection.token.access_token;
}

async function jiraRequest(path, options = {}) {
  const makeRequest = async (forceRefresh = false) => {
    const accessToken = await getAccessToken(forceRefresh);
    return fetch(`https://api.atlassian.com/ex/jira/${encodeURIComponent(jiraConnection.cloudId)}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  };
  const response = await makeRequest();
  return response.status === 401 ? makeRequest(true) : response;
}

async function getCustomFieldIds() {
  if (customFieldCache.expiresAt > Date.now()) return customFieldCache;
  const response = await jiraRequest("/rest/api/3/field");
  if (!response.ok) return { sprintId: null, storyPointsId: null };
  const fields = await response.json();
  const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sprint = fields.find(({ name }) => normalize(name) === "sprint");
  const storyPoints = fields.find(({ name }) => ["storypoints", "storypoint", "storypointestimate"].includes(normalize(name)));
  customFieldCache = {
    expiresAt: Date.now() + 5 * 60 * 1000,
    sprintId: sprint?.id ?? null,
    storyPointsId: storyPoints?.id ?? null,
  };
  return customFieldCache;
}

function descriptionDocument(text) {
  const paragraphs = String(text).split(/\r?\n/).map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  }));
  return { type: "doc", version: 1, content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }] };
}

async function jiraErrorMessage(response) {
  try {
    const result = await response.json();
    return result.errorMessages?.join(" ") || Object.values(result.errors ?? {}).join(" ") || `Jira request failed (${response.status}).`;
  } catch {
    return `Jira request failed (${response.status}).`;
  }
}

function toPlainText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toPlainText).filter(Boolean).join(" ");
  if (value.type === "text") return value.text ?? "";
  if (value.type === "hardBreak") return "\n";
  const content = (value.content ?? []).map(toPlainText).filter(Boolean).join("");
  return ["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(value.type) && content ? `${content}\n` : content;
}

function sprintNames(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((sprint) => {
    if (sprint && typeof sprint === "object") return sprint.name ?? "";
    const match = String(sprint).match(/(?:^|[,\s])name=([^,\]]+)/);
    return match?.[1]?.trim() ?? String(sprint);
  }).filter(Boolean);
}

async function searchAssignedIssues(nextPageToken, fields) {
  return jiraRequest("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      fields,
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    }),
  });
}

async function getAssignedIssues() {
  if (!jiraConnection.connected || !jiraConnection.cloudId) {
    throw new Error("Jira is not connected. Connect Jira in Settings.");
  }
  const customFields = await getCustomFieldIds();
  const fieldNames = ["summary", "status", "issuetype", "updated", "description", "labels", "reporter"];
  if (customFields.sprintId) fieldNames.push(customFields.sprintId);
  if (customFields.storyPointsId) fieldNames.push(customFields.storyPointsId);
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < 10; page += 1) {
    const response = await searchAssignedIssues(nextPageToken, fieldNames);
    if (!response.ok) {
      if (response.status === 401) throw new Error("Jira authorization expired. Reconnect Jira in Settings.");
      if (response.status === 403) throw new Error("Jira denied access to assigned issues. Check the app's Jira scopes and your Jira permissions.");
      if (response.status === 429) throw new Error("Jira is busy. Wait a moment and refresh the report.");
      throw new Error("Jira could not load assigned issues. Please try again.");
    }
    const result = await response.json();
    issues.push(...(result.issues ?? []));
    nextPageToken = result.nextPageToken;
    if (result.isLast || !nextPageToken) break;
  }

  const site = jiraConnection.sites.find(({ id }) => id === jiraConnection.cloudId);
  const siteUrl = site?.url ?? "https://jira.atlassian.com";
  return issues.map(({ key, fields = {} }) => ({
      key,
      summary: fields.summary ?? "Untitled issue",
      status: fields.status?.name ?? "Unknown",
      issueType: fields.issuetype?.name ?? "Issue",
      updated: fields.updated ?? null,
      url: `${siteUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`,
      description: toPlainText(fields.description).trim(),
      sprints: sprintNames(customFields.sprintId ? fields[customFields.sprintId] : null),
      labels: fields.labels ?? [],
      storyPointEstimate: customFields.storyPointsId ? fields[customFields.storyPointsId] ?? null : null,
      reporter: fields.reporter?.displayName ?? "Unknown",
    }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/auth/jira/start") {
    if (!clientId || !clientSecret) {
      redirect(res, settingsUrl("unconfigured"));
      return;
    }

    const state = randomBytes(32).toString("hex");
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);
    const authorizeUrl = new URL("https://auth.atlassian.com/authorize");
    authorizeUrl.search = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      prompt: "consent",
    }).toString();
    redirect(res, authorizeUrl.toString());
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/jira/callback") {
    const state = url.searchParams.get("state") ?? "";
    const expiresAt = pendingStates.get(state);
    pendingStates.delete(state);
    if (!expiresAt || expiresAt < Date.now()) {
      redirect(res, settingsUrl("invalid_state"));
      return;
    }
    if (url.searchParams.has("error")) {
      redirect(res, settingsUrl(url.searchParams.get("error") === "access_denied" ? "denied" : "error"));
      return;
    }

    try {
      const tokenResponse = await fetch("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code: url.searchParams.get("code"),
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenResponse.ok) throw new Error("Token exchange failed");
      const token = await tokenResponse.json();
      const resourcesResponse = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
      });
      if (!resourcesResponse.ok) throw new Error("Could not list Jira sites");
      const sites = await resourcesResponse.json();
      jiraConnection = {
        connected: true,
        enabled: true,
        connectedAt: new Date().toISOString(),
        cloudId: sites[0]?.id ?? null,
        sites: sites.map(({ id, name, url: siteUrl }) => ({ id, name, url: siteUrl })),
        token: null,
      };
      saveToken(token);
      redirect(res, settingsUrl("connected"));
    } catch (error) {
      console.error("Jira OAuth callback failed:", error instanceof Error ? error.message : "unknown error");
      redirect(res, settingsUrl("error"));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jira/connection") {
    const result = {
      jira: {
        configured: Boolean(clientId && clientSecret),
        connected: jiraConnection.connected,
        enabled: jiraConnection.enabled,
        connectedAt: jiraConnection.connectedAt,
        cloudId: jiraConnection.cloudId,
        sites: jiraConnection.sites,
      },
    };
    addJiraLog("GET", url.pathname, result);
    send(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jira/logs") {
    send(res, 200, { logs: jiraLogs });
    return;
  }

  const transitionsPath = url.pathname.match(/^\/api\/jira\/issues\/([^/]+)\/transitions$/);
  if (req.method === "GET" && transitionsPath) {
    if (!jiraConnection.connected) {
      send(res, 401, { error: "Jira is not connected. Connect Jira in Settings." });
      return;
    }
    try {
      const issueKey = decodeURIComponent(transitionsPath[1]);
      const response = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
      if (!response.ok) {
        send(res, response.status === 401 ? 401 : 502, { error: await jiraErrorMessage(response) });
        return;
      }
      const result = await response.json();
      const transitions = (result.transitions ?? []).map(({ id, name, to }) => ({ id, name, status: to?.name ?? name }));
      const logResult = { transitions };
      addJiraLog("GET", url.pathname, logResult);
      send(res, 200, logResult);
    } catch (error) {
      send(res, 502, { error: error instanceof Error ? error.message : "Could not load Jira status transitions." });
    }
    return;
  }

  const issueEditPath = url.pathname.match(/^\/api\/jira\/issues\/([^/]+)$/);
  if (req.method === "POST" && issueEditPath) {
    if (!jiraConnection.connected) {
      send(res, 401, { error: "Jira is not connected. Connect Jira in Settings." });
      return;
    }
    try {
      const issueKey = decodeURIComponent(issueEditPath[1]);
      let body = "";
      for await (const chunk of req) body += chunk;
      const changes = JSON.parse(body);
      const fields = {};

      if (Object.hasOwn(changes, "description")) {
        if (typeof changes.description !== "string") throw new Error("Description must be text.");
        fields.description = descriptionDocument(changes.description);
      }
      if (Object.hasOwn(changes, "storyPointEstimate")) {
        const customFields = await getCustomFieldIds();
        if (!customFields.storyPointsId) throw new Error("A story point estimate field is not configured in this Jira site.");
        const value = changes.storyPointEstimate;
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          throw new Error("Story point estimate must be a non-negative number or blank.");
        }
        if (value !== null && ![1, 2, 3, 5, 8, 13, 21].includes(value)) {
          throw new Error("Story point estimate must use a Fibonacci value: 1, 2, 3, 5, 8, 13, or 21.");
        }
        fields[customFields.storyPointsId] = value;
      }

      if (Object.keys(fields).length) {
        const response = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
        if (!response.ok) {
          send(res, response.status === 401 ? 401 : 502, { error: await jiraErrorMessage(response) });
          return;
        }
      }

      if (changes.transitionId !== undefined && changes.transitionId !== "") {
        if (typeof changes.transitionId !== "string") throw new Error("Choose a valid status transition.");
        const response = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: changes.transitionId } }),
        });
        if (!response.ok) {
          send(res, response.status === 401 ? 401 : 502, { error: await jiraErrorMessage(response) });
          return;
        }
      }

      if (!Object.keys(fields).length && !changes.transitionId) {
        send(res, 400, { error: "No changes were provided." });
        return;
      }
      addJiraLog("POST", url.pathname, { request: { issueKey, changes }, response: { ok: true } });
      send(res, 200, { ok: true });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "Could not update the Jira issue." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jira/issues") {
    if (!jiraConnection.connected) {
      send(res, 401, { error: "Jira is not connected. Connect Jira in Settings." });
      return;
    }
    if (!jiraConnection.enabled) {
      send(res, 403, { error: "Jira is connected but disabled. Enable it in Settings to load tasks." });
      return;
    }
    try {
      const issues = await getAssignedIssues();
      addJiraLog("GET", url.pathname, { issues });
      send(res, 200, { issues });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Jira could not load assigned issues. Please try again.";
      send(res, message.includes("Reconnect Jira") || message.includes("not connected") ? 401 : 502, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jira/connection/disconnect") {
    jiraConnection = { connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [], token: null };
    send(res, 200, { jira: { configured: Boolean(clientId && clientSecret), connected: false, enabled: false, connectedAt: null, cloudId: null, sites: [] } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jira/connection/enabled") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let enabled;
    try {
      enabled = JSON.parse(body).enabled;
    } catch {
      send(res, 400, { error: "Invalid request body" });
      return;
    }
    if (typeof enabled !== "boolean" || (enabled && !jiraConnection.connected)) {
      send(res, 400, { error: "Jira must be connected before it can be enabled" });
      return;
    }
    jiraConnection.enabled = enabled;
    send(res, 200, { jira: { configured: Boolean(clientId && clientSecret), connected: jiraConnection.connected, enabled, connectedAt: jiraConnection.connectedAt, cloudId: jiraConnection.cloudId, sites: jiraConnection.sites } });
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(port, () => console.log(`SnapDragons backend listening on http://localhost:${port}`));
