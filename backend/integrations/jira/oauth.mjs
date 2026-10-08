import { readConnection, saveConnection, updateConnection } from "./connection-store.mjs";

const authBase = "https://auth.atlassian.com";
const jiraApiBase = "https://api.atlassian.com";
const refreshInFlight = new Map();

export function jiraOAuthConfigured() {
  const sessionReady = Buffer.byteLength(process.env.APP_SESSION_SECRET ?? "") >= 32;
  const encryptionReady = /^[a-f\d]{64}$/i.test(process.env.JIRA_TOKEN_ENCRYPTION_KEY ?? "");
  return Boolean(process.env.JIRA_CLIENT_ID && process.env.JIRA_CLIENT_SECRET && process.env.JIRA_REDIRECT_URI && sessionReady && encryptionReady);
}

export function authorizationUrl(state) {
  if (!jiraOAuthConfigured()) throw new Error("Jira OAuth is not configured on this server.");
  const url = new URL(`${authBase}/authorize`);
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", process.env.JIRA_CLIENT_ID);
  url.searchParams.set("scope", "read:jira-work offline_access");
  url.searchParams.set("redirect_uri", process.env.JIRA_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url;
}

async function tokenRequest(body) {
  const response = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      client_id: process.env.JIRA_CLIENT_ID,
      client_secret: process.env.JIRA_CLIENT_SECRET,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error_description ?? result.error ?? "Atlassian token request failed.");
  return result;
}

export async function completeAuthorization(sessionId, code) {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.JIRA_REDIRECT_URI,
  });
  const response = await fetch(`${jiraApiBase}/oauth/token/accessible-resources`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!response.ok) throw new Error("Could not retrieve the Jira sites granted to this app.");
  const resources = await response.json();
  const sites = resources
    .filter((resource) => resource.scopes?.includes("read:jira-work"))
    .map((resource) => ({ id: resource.id, name: resource.name, url: resource.url }));
  if (sites.length === 0) throw new Error("No Jira site was authorized. Connect again and select a Jira site.");

  await saveConnection(sessionId, {
    enabled: true,
    cloudId: sites[0].id,
    sites,
    tokens: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 },
  });
}

export async function connectionSummary(sessionId) {
  const connection = await readConnection(sessionId);
  return {
    configured: jiraOAuthConfigured(),
    connected: Boolean(connection),
    enabled: connection?.enabled ?? false,
    connectedAt: connection?.connectedAt ?? null,
    sites: connection?.sites ?? [],
    cloudId: connection?.cloudId ?? null,
  };
}

export async function setConnectionEnabled(sessionId, enabled) {
  const changed = await updateConnection(sessionId, { enabled });
  if (!changed) throw new Error("Connect Jira before enabling it.");
}

export async function selectJiraSite(sessionId, cloudId) {
  const connection = await readConnection(sessionId);
  if (!connection?.sites.some((site) => site.id === cloudId)) throw new Error("That Jira site is not connected.");
  await updateConnection(sessionId, { cloudId });
}

async function currentAccessToken(sessionId) {
  const connection = await readConnection(sessionId);
  if (!connection) throw new Error("Connect Jira in Settings to load assigned tasks.");
  if (!connection.enabled) throw new Error("Jira is disabled in Settings.");
  if (connection.tokens.expiresAt > Date.now() + 60_000) return { connection, accessToken: connection.tokens.accessToken };

  const pendingRefresh = refreshInFlight.get(sessionId);
  if (pendingRefresh) return pendingRefresh;

  const refresh = (async () => {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: connection.tokens.refreshToken });
    const refreshed = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? connection.tokens.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    await saveConnection(sessionId, { ...connection, tokens: refreshed });
    return { connection: { ...connection, tokens: refreshed }, accessToken: refreshed.accessToken };
  })();
  refreshInFlight.set(sessionId, refresh);
  try {
    return await refresh;
  } finally {
    refreshInFlight.delete(sessionId);
  }
}

export async function getAssignedIssuesForSession(sessionId) {
  const { connection, accessToken } = await currentAccessToken(sessionId);
  const site = connection.sites.find((entry) => entry.id === connection.cloudId);
  if (!site) throw new Error("Select a connected Jira site in Settings.");
  const url = new URL(`${jiraApiBase}/ex/jira/${encodeURIComponent(site.id)}/rest/api/3/search/jql`);
  url.searchParams.set("jql", "assignee = currentUser() ORDER BY updated DESC");
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("fields", "summary,status,priority,issuetype,assignee,updated");
  const issues = [];
  let nextPageToken;

  do {
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    const response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      if (response.status === 401) throw new Error("Jira authorization expired. Reconnect Jira in Settings.");
      throw new Error(`Jira returned ${response.status} while loading assigned tasks.`);
    }
    const page = await response.json();
    issues.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  return issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary ?? "Untitled issue",
    status: issue.fields?.status?.name ?? "Unknown",
    priority: issue.fields?.priority?.name ?? "Unprioritized",
    issueType: issue.fields?.issuetype?.name ?? "Issue",
    assignee: issue.fields?.assignee?.displayName ?? "Unassigned",
    updated: issue.fields?.updated ?? null,
    url: `${site.url.replace(/\/$/, "")}/browse/${encodeURIComponent(issue.key)}`,
  }));
}
