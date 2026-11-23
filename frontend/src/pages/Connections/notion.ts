import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { SourceStatus } from "../Today/sources";

type ConnectionState = { configured: boolean; connected: boolean; enabled: boolean; workspace?: string | null; user?: string | null };
type State = { status: SourceStatus; account: string | null; error: string };

export type NotionConnection = State & {
  name: "notion";
  title: "Notion";
  reload: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

export function useNotionConnection(): NotionConnection {
  const [state, setState] = useState<State>({ status: "loading", account: null, error: "" });
  const reload = useCallback(async () => {
    try {
      const { notion } = await api<{ notion: ConnectionState }>("/api/notion/connection");
      setState({
        status: !notion.configured && !notion.connected ? "unconfigured" : !notion.connected ? "disconnected" : !notion.enabled ? "disabled" : "ready",
        account: notion.workspace ?? notion.user ?? null,
        error: "",
      });
    } catch (cause) {
      setState((current) => ({ ...current, status: "error", error: (cause as Error).message }));
    }
  }, []);

  const update = useCallback(async (path: "enabled" | "disconnect", body: unknown = {}) => {
    try {
      await api(`/api/notion/connection/${path}`, body);
      await reload();
    } catch (cause) {
      setState((current) => ({ ...current, status: "error", error: (cause as Error).message }));
    }
  }, [reload]);

  useEffect(() => { void reload(); }, [reload]);
  return {
    name: "notion",
    title: "Notion",
    ...state,
    reload,
    setEnabled: (enabled) => update("enabled", { enabled }),
    disconnect: () => update("disconnect"),
  };
}
