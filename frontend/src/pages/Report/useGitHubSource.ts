import { useCallback, useEffect, useState } from "react";
import { apiPath } from "../../lib/urls";
import type { Source, SourceStatus } from "./useSlackSource";

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

type GitHubConnection = { configured: boolean; connected: boolean; enabled: boolean };

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function useGitHubSource(): Source<GitHubIssue> {
  const [state, setState] = useState<{ status: SourceStatus; items: GitHubIssue[]; error: string; loadedAt: number | null }>({
    status: "loading",
    items: [],
    error: "",
    loadedAt: null,
  });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading", error: "" }));
    try {
      const connectionResponse = await fetch(apiPath("/api/github/connection"), { cache: "no-store" });
      const connection = (await readJson(connectionResponse))?.github as GitHubConnection | undefined;
      if (!connectionResponse.ok || !connection) throw new Error("The app server did not answer. Check that the backend is running.");
      if (!connection.configured && !connection.connected) return setState({ status: "unconfigured", items: [], error: "", loadedAt: null });
      if (!connection.connected) return setState({ status: "disconnected", items: [], error: "", loadedAt: null });
      if (!connection.enabled) return setState({ status: "disabled", items: [], error: "", loadedAt: null });

      const response = await fetch(apiPath("/api/github/issues"), { cache: "no-store" });
      const result = await readJson(response);
      if (!response.ok || !Array.isArray(result?.issues)) throw new Error(result?.error ?? "Could not load GitHub issues right now.");
      setState({ status: "ready", items: result.issues, error: "", loadedAt: Date.now() });
    } catch (cause) {
      const error = cause instanceof TypeError ? "Could not reach the app server. Check that it is running." : cause instanceof Error ? cause.message : "Could not load GitHub issues.";
      setState({ status: "error", items: [], error, loadedAt: null });
    }
  }, []);

  const enable = useCallback(async () => {
    await fetch(apiPath("/api/github/connection/enabled"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ enabled: true }),
    });
    await reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { name: "github", ...state, reload, enable };
}
