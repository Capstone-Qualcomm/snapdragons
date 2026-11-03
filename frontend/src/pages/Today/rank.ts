import type { GitHubIssue, ItemsOf, OutlookMessage, SlackMessage } from "./sources";
import type { JiraIssue } from "./jira";
import { api } from "../../lib/api";

// One thing on today's list, from any source.
export type Item =
  | { key: string; source: "slack"; at: number; data: SlackMessage }
  | { key: string; source: "jira"; at: number; data: JiraIssue }
  | { key: string; source: "github"; at: number; data: GitHubIssue }
  | { key: string; source: "outlook"; at: number; data: OutlookMessage };

const time = (value: string | null) => (value ? new Date(value).getTime() || 0 : 0);

export function toItems(lists: { [N in Exclude<keyof ItemsOf, "outlook">]: ItemsOf[N][] } & { outlook?: ItemsOf["outlook"][] }): Item[] {
  return [
    ...lists.slack.map((data): Item => ({ key: `slack:${data.id}`, source: "slack", at: time(data.sentAt), data })),
    ...lists.jira.map((data): Item => ({ key: `jira:${data.key}`, source: "jira", at: time(data.updated), data })),
    ...lists.github.map((data): Item => ({ key: `github:${data.id}`, source: "github", at: time(data.updatedAt), data })),
    ...(lists.outlook ?? []).map((data): Item => ({ key: `outlook:${data.id}`, source: "outlook", at: time(data.receivedAt), data })),
  ];
}

// Higher is more urgent. Unread email and direct requests come first, followed
// by active work, sprint work, mentions and the backlog.
export function score(item: Item): number {
  switch (item.source) {
    case "slack":
      return item.data.kind === "dm" ? 4 : 1;
    case "github":
      return item.data.kind === "pull_request" ? 4 : 2;
    case "jira":
      if (/progress|review/i.test(item.data.status)) return 3;
      return item.data.sprints.length ? 2 : 0;
    case "outlook":
      return 4;
  }
}

// Fast local fallback shown immediately while GCP ranks changed lists.
// Newer items come first within the same local priority band.
export function rank(items: Item[]): Item[] {
  return [...items].sort((a, b) => score(b) - score(a) || b.at - a.at);
}

// Only these fields affect the model's decision. Keep the signature local so
// refreshes with an unchanged list do not make another GCP call.
export function rankingSignature(items: Item[]): string {
  return JSON.stringify(items.map((item) => {
    switch (item.source) {
      case "slack": return [item.key, item.at, item.data.kind, item.data.from, item.data.where, item.data.text];
      case "jira": return [item.key, item.at, item.data.summary, item.data.status, item.data.issueType, item.data.sprints, item.data.labels];
      case "github": return [item.key, item.at, item.data.kind, item.data.title, item.data.repository, item.data.state];
      case "outlook": return [item.key, item.at, item.data.subject, item.data.from];
    }
  }));
}

// The gateway calls GCP with temporary row numbers instead of source IDs or
// URLs, then maps the returned order back to the local items.
export async function rankWithGcp(items: Item[]): Promise<Item[]> {
  const input = items.map((item, index) => {
    const id = String(index);
    switch (item.source) {
      case "slack": return { id, source: item.source, at: item.at, kind: item.data.kind, from: item.data.from, channel: item.data.where, text: item.data.text.slice(0, 800) };
      case "jira": return { id, source: item.source, at: item.at, summary: item.data.summary.slice(0, 800), status: item.data.status, type: item.data.issueType, sprints: item.data.sprints, labels: item.data.labels };
      case "github": return { id, source: item.source, at: item.at, kind: item.data.kind, title: item.data.title.slice(0, 800), repository: item.data.repository, state: item.data.state };
      case "outlook": return { id, source: item.source, at: item.at, subject: item.data.subject.slice(0, 800), from: item.data.from };
    }
  });
  const { order } = await api<{ order: string[] }>("/api/today/rank", { items: input });
  const byId = new Map<string, Item>();
  items.forEach((item, index) => byId.set(String(index), item));
  if (!Array.isArray(order) || order.length !== items.length || new Set(order).size !== items.length || order.some((id) => !byId.has(id))) {
    throw new Error("The model returned an invalid ranking.");
  }
  return order.map((id) => byId.get(id)!);
}
