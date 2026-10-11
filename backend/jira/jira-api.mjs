export function createJiraApi({ jiraConnection, fetchImpl, getAccessToken }) {
  let customFieldCache = { expiresAt: 0, sprintId: null, storyPointsId: null };

  async function jiraRequest(path, options = {}) {
    const makeRequest = async (forceRefresh = false) => {
      const accessToken = await getAccessToken(forceRefresh);
      return fetchImpl(`https://api.atlassian.com/ex/jira/${encodeURIComponent(jiraConnection.cloudId)}${path}`, {
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

  async function errorMessage(response) {
    try {
      const result = await response.json();
      return result.errorMessages?.join(" ") || Object.values(result.errors ?? {}).join(" ") || `Jira request failed (${response.status}).`;
    } catch {
      return `Jira request failed (${response.status}).`;
    }
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
      const response = await jiraRequest("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
          fields: fieldNames,
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
      });
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

  async function getTransitions(issueKey) {
    const response = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    if (!response.ok) return { status: response.status === 401 ? 401 : 502, error: await errorMessage(response) };
    const result = await response.json();
    return { transitions: (result.transitions ?? []).map(({ id, name, to }) => ({ id, name, status: to?.name ?? name })) };
  }

  function descriptionDocument(text) {
    const paragraphs = String(text).split(/\r?\n/).map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    }));
    return { type: "doc", version: 1, content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }] };
  }

  async function updateIssue(issueKey, changes) {
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
      if (!response.ok) return { status: response.status === 401 ? 401 : 502, error: await errorMessage(response) };
    }

    if (changes.transitionId !== undefined && changes.transitionId !== "") {
      if (typeof changes.transitionId !== "string") throw new Error("Choose a valid status transition.");
      const response = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: changes.transitionId } }),
      });
      if (!response.ok) return { status: response.status === 401 ? 401 : 502, error: await errorMessage(response) };
    }

    if (!Object.keys(fields).length && !changes.transitionId) return { status: 400, error: "No changes were provided." };
    return { ok: true };
  }

  return { getAssignedIssues, getTransitions, updateIssue };
}
