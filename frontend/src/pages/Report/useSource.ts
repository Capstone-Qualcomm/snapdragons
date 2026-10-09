import { useCallback, useEffect, useState } from "react";

export type SourceStatus = "loading" | "unconfigured" | "disconnected" | "disabled" | "error" | "ready";

export type Source<T> = {
  name: "jira" | "slack";
  status: SourceStatus;
  items: T[];
  error: string;
  loadedAt: number | null;
  reload: () => Promise<void>;
  enable: () => Promise<void>;
};

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  priority: string;
  issueType: string;
  updated: string | null;
  url: string;
};

export type SlackMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Jira and Slack share one API shape: /api/<name>/connection, then /api/<name>/<list>.
export function useSource<T>(name: "jira" | "slack", list: "issues" | "messages"): Source<T> {
  const [state, setState] = useState<{ status: SourceStatus; items: T[]; error: string; loadedAt: number | null }>({ status: "loading", items: [], error: "", loadedAt: null });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const connectionResponse = await fetch(`/api/${name}/connection`, { cache: "no-store" });
      const connection = (await readJson(connectionResponse))?.[name];
      if (!connectionResponse.ok || !connection) throw new Error("The app server did not answer. Check that the backend is running.");
      if (!connection.configured && !connection.connected) return setState({ status: "unconfigured", items: [], error: "", loadedAt: null });
      if (!connection.connected) return setState({ status: "disconnected", items: [], error: "", loadedAt: null });
      if (!connection.enabled) return setState({ status: "disabled", items: [], error: "", loadedAt: null });

      const response = await fetch(`/api/${name}/${list}`, { cache: "no-store" });
      const result = await readJson(response);
      if (!response.ok || !Array.isArray(result?.[list])) throw new Error(result?.error ?? `Could not load ${name} right now.`);
      setState({ status: "ready", items: result[list], error: "", loadedAt: Date.now() });
    } catch (cause) {
      const error = cause instanceof TypeError ? "Could not reach the app server. Check that it is running." : cause instanceof Error ? cause.message : `Could not load ${name}.`;
      setState({ status: "error", items: [], error, loadedAt: null });
    }
  }, [name, list]);

  const enable = useCallback(async () => {
    await fetch(`/api/${name}/connection/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ enabled: true }),
    });
    await reload();
  }, [name, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { name, ...state, reload, enable };
}

export function ago(time: string | number, now: number) {
  const minutes = Math.round((now - new Date(time).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}
