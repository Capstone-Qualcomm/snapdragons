import { api } from "../../lib/api";

export async function postGitHubComment(repository: string, issueNumber: number, body: string): Promise<void> {
  const [owner, repo] = repository.split("/");
  await api(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`, { body });
}
