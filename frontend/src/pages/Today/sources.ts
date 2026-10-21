import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { JiraIssue } from "./jira";

export type SourceName = "jira" | "slack" | "github";
export type SourceStatus = "loading" | "unconfigured" | "disconnected" | "disabled" | "error" | "ready";

export type SlackMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

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

export type ItemsOf = { slack: SlackMessage; jira: JiraIssue; github: GitHubIssue };

type Connection = {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  team?: string | null;
  user?: string | null;
  cloudId?: string | null;
  sites?: Array<{ id: string; name: string }>;
};

export type Source<T> = {
  name: SourceName;
  title: string;
  status: SourceStatus;
  // True while a sync runs; the last list stays on screen until it finishes,
  // and after it if the sync fails.
  syncing: boolean;
  items: T[];
  error: string;
  loadedAt: number | null;
  // The workspace, user or site it is connected as.
  account: string | null;
  reload: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

type State<T> = Pick<Source<T>, "status" | "syncing" | "items" | "error" | "loadedAt" | "account">;

export const titles: Record<SourceName, string> = { jira: "Jira", slack: "Slack", github: "GitHub" };
const lists: Record<SourceName, string> = { jira: "issues", slack: "messages", github: "issues" };

const accountOf = (connection: Connection) =>
  connection.team ?? connection.user ?? connection.sites?.find((site) => site.id === connection.cloudId)?.name ?? null;

// Checks the source's connection, then loads its list from /api/<name>/<list>.
export function useSource<N extends SourceName>(name: N): Source<ItemsOf[N]> {
  type T = ItemsOf[N];
  const items = lists[name];
  const [state, setState] = useState<State<T>>({ status: "loading", syncing: true, items: [], error: "", loadedAt: null, account: null });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, syncing: true }));
    const settle = (status: SourceStatus) => setState({ status, syncing: false, items: [], error: "", loadedAt: null, account: null });
    try {
      const connection = (await api<Record<SourceName, Connection>>(`/api/${name}/connection`))[name];
      if (!connection.configured && !connection.connected) return settle("unconfigured");
      if (!connection.connected) return settle("disconnected");
      if (!connection.enabled) return settle("disabled");
      const result = await api<Record<string, T[]>>(`/api/${name}/${items}`);
      setState({ status: "ready", syncing: false, items: result[items], error: "", loadedAt: Date.now(), account: accountOf(connection) });
    } catch (cause) {
      // A failed sync keeps the last list, and any edits open in it, beside the error.
      setState((current) => ({ ...current, status: "error", syncing: false, error: (cause as Error).message }));
    }
  }, [name, items]);

  const post = useCallback(async (path: string, body: unknown = {}) => {
    try {
      await api(`/api/${name}/connection/${path}`, body);
      await reload();
    } catch (cause) {
      setState((current) => ({ ...current, status: "error", error: (cause as Error).message }));
    }
  }, [name, reload]);

  const setEnabled = useCallback((enabled: boolean) => post("enabled", { enabled }), [post]);
  const disconnect = useCallback(() => post("disconnect"), [post]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { name, title: titles[name], ...state, reload, setEnabled, disconnect };
}
