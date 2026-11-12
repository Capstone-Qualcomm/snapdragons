import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { JiraIssue } from "./jira";

export type SourceName = "jira" | "slack" | "github" | "outlook" | "teams";
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

export type OutlookMessage = {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  url: string;
};

export type TeamsMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

export type ItemsOf = { slack: SlackMessage; jira: JiraIssue; github: GitHubIssue; outlook: OutlookMessage; teams: TeamsMessage };

type Connection = {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  team?: string | null;
  user?: string | null;
  cloudId?: string | null;
  sites?: Array<{ id: string; name: string }>;
  email?: string | null;
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
  // With a refresh, the list comes from what the boards loaded in it, or the source's own if they did not.
  reload: (refresh?: Refresh) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

// A cluster refresh's job, and when this page started following it.
export type Refresh = { job: string; since: number };

type State<T> = Pick<Source<T>, "status" | "syncing" | "items" | "error" | "loadedAt" | "account">;

export const titles: Record<SourceName, string> = { jira: "Jira", slack: "Slack", github: "GitHub", outlook: "Outlook", teams: "Teams" };
const lists: Record<SourceName, string> = { jira: "issues", slack: "messages", github: "issues", outlook: "messages", teams: "messages" };

const accountOf = (connection: Connection) =>
  connection.team ?? connection.user ?? connection.email ?? connection.sites?.find((site) => site.id === connection.cloudId)?.name ?? null;

// Checks the source's connection, then loads its list from /api/<name>/<list>.
export function useSource<N extends SourceName>(name: N): Source<ItemsOf[N]> {
  type T = ItemsOf[N];
  const items = lists[name];
  const [state, setState] = useState<State<T>>({ status: "loading", syncing: true, items: [], error: "", loadedAt: null, account: null });

  // Only the newest sync may write, so a slow older one cannot bring back a list a Turn off or Disconnect cleared.
  const latest = useRef(0);
  // When the page last loaded this source's list itself, say after a Jira save.
  const ownAt = useRef(0);

  const reload = useCallback(async (refresh?: Refresh) => {
    // The boards' list is older than one the page asked for since the refresh began, so it would undo that save.
    if (refresh && ownAt.current > refresh.since) return;
    if (!refresh) ownAt.current = Date.now();
    const sync = ++latest.current;
    const write = (next: State<T> | ((current: State<T>) => State<T>)) => {
      if (sync === latest.current) setState(next);
    };
    setState((current) => ({ ...current, syncing: true }));
    const settle = (status: SourceStatus) => write({ status, syncing: false, items: [], error: "", loadedAt: null, account: null });
    try {
      const connection = (await api<Record<SourceName, Connection>>(`/api/${name}/connection`))[name];
      if (!connection.configured && !connection.connected) return settle("unconfigured");
      if (!connection.connected) return settle("disconnected");
      if (!connection.enabled) return settle("disabled");
      const own = () => api<Record<string, T[]>>(`/api/${name}/${items}`);
      const result = refresh ? await api<Record<string, T[]>>(`/api/cluster/refresh/${refresh.job}/${name}`, {}).catch(own) : await own();
      write({ status: "ready", syncing: false, items: result[items], error: "", loadedAt: Date.now(), account: accountOf(connection) });
    } catch (cause) {
      // A failed sync keeps the last list, and any edits open in it, beside the error.
      write((current) => ({ ...current, status: "error", syncing: false, error: (cause as Error).message }));
    }
  }, [name, items]);

  const post = useCallback(async (path: string, body: unknown = {}) => {
    latest.current++;
    try {
      await api(`/api/${name}/connection/${path}`, body);
      await reload();
    } catch (cause) {
      setState((current) => ({ ...current, status: "error", syncing: false, error: (cause as Error).message }));
    }
  }, [name, reload]);

  const setEnabled = useCallback((enabled: boolean) => post("enabled", { enabled }), [post]);
  const disconnect = useCallback(() => post("disconnect"), [post]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { name, title: titles[name], ...state, reload, setEnabled, disconnect };
}
