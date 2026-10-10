export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  updated: string | null;
  url: string;
  description: string;
  sprints: string[];
  labels: string[];
  storyPointEstimate: number | string | null;
  reporter: string;
};

export type JiraTransition = { id: string; name: string; status: string };
export type JiraChanges = { description: string; storyPointEstimate: number | null; transitionId: string };
export type JiraConnection = { connected: boolean; enabled: boolean };

type JiraErrorResponse = { error?: string };

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await readJson<T & JiraErrorResponse>(response);
  if (!response.ok) throw new Error(result?.error ?? "Could not load Jira data. Please try again.");
  if (result == null) throw new Error("Could not load Jira data. Please try again.");
  return result;
}

export async function getJiraConnection(): Promise<JiraConnection> {
  const result = await request<{ jira?: Partial<JiraConnection> }>("/api/jira/connection", { cache: "no-store" });
  if (typeof result.jira?.connected !== "boolean" || typeof result.jira.enabled !== "boolean") {
    throw new Error("Could not check connected apps. Please try again.");
  }
  return { connected: result.jira.connected, enabled: result.jira.enabled };
}

export async function getAssignedJiraIssues(): Promise<JiraIssue[]> {
  const result = await request<{ issues?: JiraIssue[] }>("/api/jira/issues", { cache: "no-store" });
  if (!Array.isArray(result.issues)) throw new Error("Could not load tasks right now. Please try again.");
  return result.issues;
}

export async function getJiraTransitions(issueKey: string): Promise<JiraTransition[]> {
  const result = await request<{ transitions?: JiraTransition[] }>(
    `/api/jira/issues/${encodeURIComponent(issueKey)}/transitions`,
    { cache: "no-store" },
  );
  return result.transitions ?? [];
}

export async function updateJiraIssue(issueKey: string, changes: JiraChanges): Promise<void> {
  await request<{ ok?: boolean }>(`/api/jira/issues/${encodeURIComponent(issueKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify(changes),
  });
}
