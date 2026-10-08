const jiraFields = ["summary", "status", "priority", "issuetype", "assignee", "updated"];

function configuration() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Configure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in the environment.");
  }

  return { baseUrl: JIRA_BASE_URL.replace(/\/$/, ""), email: JIRA_EMAIL, token: JIRA_API_TOKEN };
}

export async function getAssignedIssues() {
  const { baseUrl, email, token } = configuration();
  const url = new URL(`${baseUrl}/rest/api/3/search/jql`);
  url.searchParams.set("jql", "assignee = currentUser() ORDER BY updated DESC");
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("fields", jiraFields.join(","));
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
  };
  const issues = [];
  let nextPageToken;

  do {
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    else url.searchParams.delete("nextPageToken");
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Jira returned ${response.status}: ${detail.slice(0, 400)}`);
    }

    const result = await response.json();
    issues.push(...(result.issues ?? []));
    nextPageToken = result.nextPageToken;
  } while (nextPageToken);

  return issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary ?? "Untitled issue",
    status: issue.fields?.status?.name ?? "Unknown",
    priority: issue.fields?.priority?.name ?? "Unprioritized",
    issueType: issue.fields?.issuetype?.name ?? "Issue",
    assignee: issue.fields?.assignee?.displayName ?? "Unassigned",
    updated: issue.fields?.updated ?? null,
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
  }));
}
