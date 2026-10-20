import type { GitHubIssue, ItemsOf, SlackMessage } from "./sources";
import type { JiraIssue } from "./jira";

// One thing on today's list, from any source.
export type Item =
  | { key: string; source: "slack"; at: number; data: SlackMessage }
  | { key: string; source: "jira"; at: number; data: JiraIssue }
  | { key: string; source: "github"; at: number; data: GitHubIssue };

const time = (value: string | null) => (value ? new Date(value).getTime() || 0 : 0);

export function toItems(lists: { [N in keyof ItemsOf]: ItemsOf[N][] }): Item[] {
  return [
    ...lists.slack.map((data): Item => ({ key: `slack:${data.id}`, source: "slack", at: time(data.sentAt), data })),
    ...lists.jira.map((data): Item => ({ key: `jira:${data.key}`, source: "jira", at: time(data.updated), data })),
    ...lists.github.map((data): Item => ({ key: `github:${data.id}`, source: "github", at: time(data.updatedAt), data })),
  ];
}

// Higher is more urgent. Someone waiting on you comes first, then work you
// have started, then work planned for this sprint, then mentions, then the backlog.
export function score(item: Item): number {
  switch (item.source) {
    case "slack":
      return item.data.kind === "dm" ? 4 : 1;
    case "github":
      return item.data.kind === "pull_request" ? 4 : 2;
    case "jira":
      if (/progress|review/i.test(item.data.status)) return 3;
      return item.data.sprints.length ? 2 : 0;
  }
}

// The order Today shows. Newer first within the same score.
// ponytail: fixed rules; swap this one function for an LLM call (QT1S-26) without touching the page.
export function rank(items: Item[]): Item[] {
  return [...items].sort((a, b) => score(b) - score(a) || b.at - a.at);
}
