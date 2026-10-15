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
  // Requests open issues assigned to signed-in user. Each result converted into small, consistent item.
  async function getAssignedOpenIssues(accessToken: string): Promise<GitHubWorkItem[]> {
    if (!accessToken) throw new Error("GitHub is not connected. Connect GitHub in Settings.");

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
        throw new Error("GitHub authorization expired. Reconnect GitHub in Settings.");
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

  return { getAssignedOpenIssues };
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
