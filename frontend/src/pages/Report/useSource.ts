import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";

export type SourceName = "jira" | "slack" | "github";
export type SourceStatus = "loading" | "unconfigured" | "disconnected" | "disabled" | "error" | "ready";

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
  reload: () => Promise<void>;
  enable: () => Promise<void>;
};

type Connection = { configured: boolean; connected: boolean; enabled: boolean };
type State<T> = Pick<Source<T>, "status" | "syncing" | "items" | "error" | "loadedAt">;

export const titles: Record<SourceName, string> = { jira: "Jira", slack: "Slack", github: "GitHub" };

// Checks the source's connection, then loads its list from /api/<name>/<items>.
export function useSource<T>(name: SourceName, items: string): Source<T> {
  const [state, setState] = useState<State<T>>({ status: "loading", syncing: true, items: [], error: "", loadedAt: null });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, syncing: true }));
    const settle = (status: SourceStatus) => setState({ status, syncing: false, items: [], error: "", loadedAt: null });
    try {
      const connection = (await api<Record<SourceName, Connection>>(`/api/${name}/connection`))[name];
      if (!connection.configured && !connection.connected) return settle("unconfigured");
      if (!connection.connected) return settle("disconnected");
      if (!connection.enabled) return settle("disabled");
      const result = await api<Record<string, T[]>>(`/api/${name}/${items}`);
      setState({ status: "ready", syncing: false, items: result[items], error: "", loadedAt: Date.now() });
    } catch (cause) {
      // A failed sync keeps the last list, and any edits open in it, beside the error.
      setState((current) => ({ ...current, status: "error", syncing: false, error: (cause as Error).message }));
    }
  }, [name, items]);

  const enable = useCallback(async () => {
    try {
      await api(`/api/${name}/connection/enabled`, { enabled: true });
      await reload();
    } catch (cause) {
      setState((current) => ({ ...current, status: "error", error: (cause as Error).message }));
    }
  }, [name, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { name, title: titles[name], ...state, reload, enable };
}
