import { api } from "../../../lib/api";
import { useSource } from "../useSource";

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
export type JiraChanges = { description?: string; storyPointEstimate?: number | null; transitionId?: string };

export const useJiraSource = () => useSource<JiraIssue>("jira", "issues");

export async function getJiraTransitions(issueKey: string): Promise<JiraTransition[]> {
  const result = await api<{ transitions?: JiraTransition[] }>(`/api/jira/issues/${encodeURIComponent(issueKey)}/transitions`);
  return result.transitions ?? [];
}

// Writes to the real Jira issue.
export async function updateJiraIssue(issueKey: string, changes: JiraChanges): Promise<void> {
  await api(`/api/jira/issues/${encodeURIComponent(issueKey)}`, changes);
}
