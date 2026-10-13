import { useCallback, useEffect, useState } from "react";
import { apiPath } from "../../lib/urls";

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

export function useSlackSource(): Source<SlackMessage> {
  const [state, setState] = useState<{ status: SourceStatus; items: SlackMessage[]; error: string; loadedAt: number | null }>({ status: "loading", items: [], error: "", loadedAt: null });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const connectionResponse = await fetch(apiPath("/api/slack/connection"), { cache: "no-store" });
      const connection = (await readJson(connectionResponse))?.slack;
      if (!connectionResponse.ok || !connection) throw new Error("The app server did not answer. Check that the backend is running.");
      if (!connection.configured && !connection.connected) return setState({ status: "unconfigured", items: [], error: "", loadedAt: null });
      if (!connection.connected) return setState({ status: "disconnected", items: [], error: "", loadedAt: null });
      if (!connection.enabled) return setState({ status: "disabled", items: [], error: "", loadedAt: null });

      const response = await fetch(apiPath("/api/slack/messages"), { cache: "no-store" });
      const result = await readJson(response);
      if (!response.ok || !Array.isArray(result?.messages)) throw new Error(result?.error ?? "Could not load Slack right now.");
      setState({ status: "ready", items: result.messages, error: "", loadedAt: Date.now() });
    } catch (cause) {
      const error = cause instanceof TypeError ? "Could not reach the app server. Check that it is running." : cause instanceof Error ? cause.message : "Could not load Slack.";
      setState({ status: "error", items: [], error, loadedAt: null });
    }
  }, []);

  const enable = useCallback(async () => {
    await fetch(apiPath("/api/slack/connection/enabled"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ enabled: true }),
    });
    await reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { name: "slack", ...state, reload, enable };
}

export function ago(time: string | number, now: number) {
  const minutes = Math.round((now - new Date(time).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}
