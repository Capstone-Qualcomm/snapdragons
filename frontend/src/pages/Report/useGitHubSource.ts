import { useSource } from "./useSource";

export type GitHubIssue = {
  id: string;
  kind: "issue" | "pull_request";
  repository: string;
  number: number;
  title: string;
  state: "open";
  updatedAt: string;
  url: string;
};

export const useGitHubSource = () => useSource<GitHubIssue>("github", "issues");
