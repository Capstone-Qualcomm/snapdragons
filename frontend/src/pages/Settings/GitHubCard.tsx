import { useCallback, useEffect, useState } from "react";
import { apiPath, appPath } from "../../lib/urls";
import "./GitHubCard.css";

type GitHubConnection = {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  user: string | null;
};

const emptyConnection: GitHubConnection = {
  configured: false,
  connected: false,
  enabled: false,
  connectedAt: null,
  user: null,
};

const callbackMessages: Record<string, string> = {
  connected: "GitHub is connected. Assigned issues and PRs are ready to load in Report.",
  denied: "GitHub access was not granted.",
  error: "GitHub could not be connected. Check the server configuration and try again.",
  invalid_state: "The GitHub sign-in expired or could not be verified. Please connect again.",
  unconfigured: "GitHub sign-in is not configured on this server yet.",
};

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function GitHubCard() {
  const [github, setGitHub] = useState(emptyConnection);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });

  const loadConnection = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(apiPath("/api/github/connection"), { cache: "no-store" });
      const result = await readJson<{ github?: GitHubConnection; error?: string }>(response);
      if (!response.ok || !result?.github) throw new Error(result?.error ?? "Could not load GitHub status.");
      setGitHub(result.github);
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Could not load GitHub status.", isError: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("github");
    if (outcome && callbackMessages[outcome]) {
      setMessage({ text: callbackMessages[outcome], isError: outcome !== "connected" });
      window.history.replaceState({}, "", window.location.pathname);
    }
    void loadConnection();
  }, [loadConnection]);

  async function post(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage({ text: "", isError: false });
    try {
      const response = await fetch(apiPath(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify(body),
      });
      const result = await readJson<{ github?: GitHubConnection; error?: string }>(response);
      if (!response.ok || !result?.github) throw new Error(result?.error ?? "Could not update the GitHub connection.");
      setGitHub(result.github);
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Could not update the GitHub connection.", isError: true });
    } finally {
      setBusy(false);
    }
  }

  const blocked = !github.configured || loading || busy;

  return (
    <section className="settings-app-card" aria-labelledby="github-app-title">
      <div className="settings-app-header">
        <div className="settings-app-icon settings-app-icon-github" aria-hidden="true">
          <img src={appPath("github-logo.png")} alt="" />
        </div>
        <div className="settings-app-name">
          <h2 id="github-app-title">GitHub</h2>
          <p>{github.user ? `Connected as ${github.user}` : "Assigned open issues and PRs from your repositories"}</p>
        </div>
        <span className={`settings-connection-state ${github.connected ? "is-connected" : ""}`}>
          {loading ? "Checking…" : github.connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {message.text && <p className={`github-card-notice${message.isError ? " is-error" : ""}`} role={message.isError ? "alert" : "status"}>{message.text}</p>}

      <div className="github-access">
        <span className="github-access-label">Reads</span>
        <span className="github-access-chip">Open issues assigned to you</span>
      </div>

      <div className="settings-app-controls">
        <div className="settings-enable-copy">
          <span className="settings-enable-title">Include GitHub in Report</span>
          <span className="settings-enable-description">
            {github.enabled ? "GitHub issues and PRs appear in your report." : "GitHub issues and PRs are not currently included."}
          </span>
        </div>
        <label className="settings-toggle">
          <span className="visually-hidden">Enable GitHub issues in Report</span>
          <input
            type="checkbox"
            checked={github.enabled}
            disabled={loading || busy || !github.connected}
            onChange={(event) => void post("/api/github/connection/enabled", { enabled: event.target.checked })}
          />
          <span className="settings-toggle-track" aria-hidden="true" />
        </label>
      </div>

      <div className="settings-app-actions">
        {!github.connected ? (
          <>
            <a className={`settings-primary-button ${blocked ? "is-disabled" : ""}`} href={blocked ? undefined : appPath("auth/github/start")} aria-disabled={blocked} tabIndex={blocked ? -1 : undefined}>
              Connect GitHub
            </a>
            {!github.configured && !loading && <span className="settings-hint">The app administrator needs to configure GitHub App credentials.</span>}
          </>
        ) : (
          <>
            <a className="settings-secondary-button" href={appPath("auth/github/start")}>Reconnect</a>
            <button className="settings-text-button" type="button" disabled={busy} onClick={() => void post("/api/github/connection/disconnect", {})}>
              Disconnect
            </button>
          </>
        )}
        <button className="settings-refresh" type="button" disabled={loading || busy} onClick={() => void loadConnection()}>
          Refresh status
        </button>
      </div>
    </section>
  );
}
