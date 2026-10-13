import { useMemo, useState } from "react";
import { apiPath } from "../../lib/urls";
import type { JiraIssue } from "./jira/jiraService";
import type { SlackMessage, Source } from "./useSlackSource";
import "./PriorityList.css";

type PriorityItem = {
  id: string;
  source: "Jira" | "Slack";
  title: string;
  detail: string;
  url: string;
  updatedAt: string | null;
};

type RankResponse = { rankedIds?: string[]; error?: string };

function makeItems(issues: JiraIssue[], messages: SlackMessage[]): PriorityItem[] {
  return [
    ...issues.map((issue) => ({
      id: `jira:${issue.key}`,
      source: "Jira" as const,
      title: issue.summary,
      detail: `${issue.key} · ${issue.status}`,
      url: issue.url,
      updatedAt: issue.updated,
    })),
    ...messages.map((message) => ({
      id: `slack:${message.id}`,
      source: "Slack" as const,
      title: message.text || `${message.kind === "dm" ? "Message" : "Mention"} from ${message.from}`,
      detail: `${message.from} · ${message.where}`,
      url: message.url,
      updatedAt: message.sentAt,
    })),
  ];
}

export function PriorityList({ issues, slack }: { issues: JiraIssue[]; slack: Source<SlackMessage> }) {
  const items = useMemo(() => makeItems(issues, slack.status === "ready" ? slack.items : []), [issues, slack.items, slack.status]);
  const [rankedResult, setRankedResult] = useState<{ ids: string[]; itemKey: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const itemKey = items.map(({ id }) => id).join("\n");
  const rankedIds = rankedResult?.itemKey === itemKey ? rankedResult.ids : null;
  const orderedItems = rankedIds ? rankedIds.map((id) => items.find((item) => item.id === id)).filter((item): item is PriorityItem => Boolean(item)) : items;

  async function rankList() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiPath("api/rank"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify({ items }),
      });
      const result = await response.json() as RankResponse;
      if (!response.ok || !Array.isArray(result.rankedIds)) throw new Error(result.error ?? "Could not rank these items.");
      if (result.rankedIds.length !== items.length || new Set(result.rankedIds).size !== items.length || result.rankedIds.some((id) => !items.some((item) => item.id === id))) {
        throw new Error("The ranking response did not match the item list. Try again.");
      }
      setRankedResult({ ids: result.rankedIds, itemKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rank these items.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="priority-list" aria-labelledby="priority-title">
      <header className="priority-header">
        <div>
          <h2 id="priority-title">Today’s priority list</h2>
          <p>Jira and Slack work, together in one place.</p>
        </div>
        <button type="button" onClick={() => void rankList()} disabled={loading || items.length === 0}>
          {loading ? "Ranking…" : rankedIds ? "Rank again ↻" : "Rank with AI"}
        </button>
      </header>
      {error && <p className="priority-error" role="alert">{error}</p>}
      {items.length === 0 ? (
        <p className="priority-empty">Connect and enable Jira or Slack to add items here.</p>
      ) : (
        <ol className="priority-items">
          {orderedItems.map((item, index) => (
            <li className="priority-item" key={item.id}>
              <span className="priority-number">{String(index + 1).padStart(2, "0")}</span>
              <div className="priority-item-body">
                <span className={`priority-source source-${item.source.toLowerCase()}`}>{item.source}</span>
                <p>{item.title}</p>
                <small>{item.detail}{item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleString()}` : ""}</small>
              </div>
              {item.url && <a href={item.url} target="_blank" rel="noreferrer">Open ↗</a>}
            </li>
          ))}
        </ol>
      )}
      <div className="priority-outlook"><strong>Outlook</strong><span>Not connected yet · email tasks can appear here later</span></div>
    </section>
  );
}
