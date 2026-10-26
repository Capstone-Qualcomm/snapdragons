export type GitHubWorkItem = {
  id: string;
  kind: "issue" | "pull_request";
  repository: string;
  number: number;
  title: string;
  state: "open";
  updatedAt: string;
  url: string;
};

type GitHubApiIssue = {
  number?: number;
  title?: string;
  state?: string;
  updated_at?: string;
  html_url?: string;
  repository?: { full_name?: string };
  pull_request?: { html_url?: string };
};

type GitHubApiOptions = {
  fetchImpl?: typeof fetch;
};

const apiUrl = "https://api.github.com/issues";
const apiVersion = "2026-03-10";

export function createGitHubApi({ fetchImpl = globalThis.fetch }: GitHubApiOptions = {}) {
  async function postComment(accessToken: string, repository: string, issueNumber: number, body: unknown): Promise<{ status: number; error: string } | { ok: true }> {
    if (!accessToken) throw new Error("GitHub is not connected. Connect GitHub.");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Choose a valid GitHub repository.");
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Choose a valid GitHub issue or pull request.");
    if (typeof body !== "string" || !body.trim()) throw new Error("Comment cannot be empty.");
    if (body.length > 65_536) throw new Error("Comment must be 65,536 characters or fewer.");

    const [owner, repo] = repository.split("/");
    const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": apiVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });

    if (response.status === 401) return { status: 401, error: "GitHub authorization expired. Reconnect GitHub." };
    if (response.status === 403 || response.status === 429) return { status: response.status, error: await commentFailure(response) };
    if (!response.ok) return { status: response.status === 404 ? 404 : 502, error: `GitHub could not post the comment (HTTP ${response.status}). Please try again.` };
    return { ok: true };
  }

  async function commentFailure(response: Response): Promise<string> {
    const message = await response.clone().json().then((result: unknown) => {
      if (result && typeof result === "object" && "message" in result && typeof result.message === "string") return result.message;
      return "";
    }).catch(() => "");
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const reset = response.headers.get("X-RateLimit-Reset");
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 || remaining === "0" || /rate limit|secondary rate limit|abuse detection/i.test(message)) {
      if (retryAfter && Number.isFinite(Number(retryAfter))) return `GitHub rate limit reached. Try again in ${retryAfter} seconds.`;
      if (remaining === "0" && reset && Number.isFinite(Number(reset))) return `GitHub rate limit reached. Try again after ${new Date(Number(reset) * 1000).toUTCString()}.`;
      return "GitHub rate limit reached. Wait a minute, then try again.";
    }

    const accepted = response.headers.get("X-Accepted-GitHub-Permissions");
    if (/resource not accessible|insufficient|permission/i.test(message) || accepted) {
      const required = accepted ? ` GitHub reports the required permission as ${accepted}.` : "";
      return `GitHub rejected the comment because this authorization cannot write to that repository. Check the GitHub App's repository permissions and that the repository is included in its installation, then reconnect GitHub.${required}${message ? ` GitHub said: ${message}` : ""}`;
    }
    return message ? `GitHub denied the comment: ${message}` : "GitHub denied the comment (HTTP 403). Check the GitHub App's repository permissions and try again.";
  }

  // Requests open issues assigned to signed-in user. Each result converted into small, consistent item.
  async function getAssignedOpenIssues(accessToken: string): Promise<GitHubWorkItem[]> {
    if (!accessToken) throw new Error("GitHub is not connected. Connect GitHub.");

    const items: GitHubWorkItem[] = [];
    let nextUrl: string | null = buildFirstPageUrl();

    while (nextUrl) {
      const response = await fetchImpl(nextUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "X-GitHub-Api-Version": apiVersion,
        },
      });

      if (response.status === 401) {
        throw new Error("GitHub authorization expired. Reconnect GitHub.");
      }
      if (response.status === 403) {
        throw new Error("GitHub denied access or the API rate limit was reached. Check the GitHub app permissions and try again later.");
      }
      if (!response.ok) {
        throw new Error(`GitHub could not load assigned issues (HTTP ${response.status}). Please try again.`);
      }

      const page = await response.json() as GitHubApiIssue[];
      if (!Array.isArray(page)) throw new Error("GitHub returned an unexpected response while loading issues.");
      items.push(...page.filter(isOpenAssignedItem).map(toWorkItem));
      nextUrl = getNextPageUrl(response.headers.get("Link"));
    }

    return items;
  }

  function buildFirstPageUrl(): string {
    const url = new URL(apiUrl);
    url.searchParams.set("filter", "assigned");
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", "100");
    return url.toString();
  }

  return { getAssignedOpenIssues, postComment };
}

function isOpenAssignedItem(item: GitHubApiIssue): boolean {
  return typeof item.number === "number"
    && typeof item.title === "string"
    && item.state === "open"
    && typeof item.repository?.full_name === "string"
    && typeof item.html_url === "string"
    && typeof item.updated_at === "string";
}

function toWorkItem(item: GitHubApiIssue): GitHubWorkItem {
  const repository = item.repository!.full_name!;
  const number = item.number!;
  return {
    id: `github:${repository}#${number}`,
    kind: item.pull_request ? "pull_request" : "issue",
    repository,
    number,
    title: item.title!,
    state: "open",
    updatedAt: item.updated_at!,
    url: item.pull_request?.html_url ?? item.html_url!,
  };
}

function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextLink = linkHeader.split(",").find((link) => /rel="next"/.test(link));
  return nextLink?.match(/<([^>]+)>/)?.[1] ?? null;
}
