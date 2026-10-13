import { useCallback, useEffect, useState } from "react";
import "./Settings.css";
import { SlackCard } from "./SlackCard";
import { apiPath, appPath } from "../../lib/urls";

type JiraConnection = {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  cloudId: string | null;
  sites: Array<{ id: string; name: string; url: string }>;
};

const emptyConnection: JiraConnection = {
  configured: false,
  connected: false,
  enabled: false,
  connectedAt: null,
  cloudId: null,
  sites: [],
};

const callbackMessages: Record<string, string> = {
  connected: "Jira is connected. Your assigned tasks are ready to load in Report.",
  denied: "Jira access was not granted.",
  error: "Jira could not be connected. Check the server configuration and try again.",
  invalid_state: "The Jira sign-in expired or could not be verified. Please connect again.",
  unconfigured: "Jira sign-in is not configured on this server yet.",
};

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function SettingsPage() {
  const [jira, setJira] = useState(emptyConnection);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiPath("/api/jira/connection"), { cache: "no-store" });
      const result = await readJson<{ jira?: JiraConnection; error?: string }>(response);
      if (!response.ok) throw new Error(result?.error ?? "Could not load connection status. Check the server and refresh.");
      if (!result?.jira) throw new Error("Could not load connection status. Check the server and refresh.");
      setJira(result.jira);
    } catch (cause) {
      setError(cause instanceof TypeError ? "Could not reach the app server. Check that it is running, then refresh." : cause instanceof Error ? cause.message : "Could not load connection status. Check the server and refresh.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("jira");
    if (outcome && callbackMessages[outcome]) {
      setNotice(callbackMessages[outcome]);
      window.history.replaceState({}, "", window.location.pathname);
    }
    void loadConnections();
  }, [loadConnections]);

  async function updateConnection(path: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(apiPath(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
        body: JSON.stringify(body),
      });
      const result = await readJson<{ jira?: JiraConnection; error?: string }>(response);
      if (!response.ok) throw new Error(result?.error ?? "Could not update the Jira connection. Please try again.");
      if (!result?.jira) throw new Error("Could not update the Jira connection. Please try again.");
      setJira(result.jira);
      return true;
    } catch (cause) {
      setError(cause instanceof TypeError ? "Could not reach the app server. Check that it is running, then try again." : cause instanceof Error ? cause.message : "Could not update the Jira connection. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function disconnectJira() {
    const disconnected = await updateConnection("/api/jira/connection/disconnect", {});
    if (disconnected) setNotice("Jira was disconnected from this app. You can also revoke its access from your Atlassian account settings.");
  }

  const selectedSite = jira.sites.find((site) => site.id === jira.cloudId);

  return (
    <section className="settings-view">
      <header className="settings-heading">
        <div>
          <h1>Settings</h1>
          <p className="settings-description">Choose which apps can provide tasks to your report.</p>
        </div>
      </header>

      {notice && <p className="settings-message settings-notice" role="status">{notice}</p>}
      {error && <p className="settings-message settings-error" role="alert">{error}</p>}

      <section className="settings-app-card" aria-labelledby="jira-app-title">
        <div className="settings-app-header">
          <div className="settings-app-icon" aria-hidden="true">
            <img src={appPath("jira-logo.png")} alt="" />
          </div>
          <div className="settings-app-name">
            <h2 id="jira-app-title">Jira</h2>
            <p>Assigned issues from your Jira Cloud account</p>
          </div>
          <span className={`settings-connection-state ${jira.connected ? "is-connected" : ""}`}>
            {loading ? "Checking…" : jira.connected ? "Connected" : "Not connected"}
          </span>
        </div>

        <div className="settings-app-controls">
          <div className="settings-enable-copy">
            <span className="settings-enable-title">Include Jira in Report</span>
            <span className="settings-enable-description">
              {jira.enabled ? "Jira tasks appear in your report." : "Jira tasks are not currently included."}
            </span>
          </div>
          <label className="settings-toggle">
            <span className="visually-hidden">Enable Jira tasks in Report</span>
            <input
              type="checkbox"
              checked={jira.enabled}
              disabled={loading || busy || !jira.connected}
              onChange={(event) => void updateConnection("/api/jira/connection/enabled", { enabled: event.target.checked })}
            />
            <span className="settings-toggle-track" aria-hidden="true" />
          </label>
        </div>

        {jira.connected && jira.sites.length > 1 && (
          <label className="settings-site-field">
            Jira site
            <select
              value={jira.cloudId ?? ""}
              disabled={busy}
              onChange={(event) => void updateConnection("/api/jira/connection/site", { cloudId: event.target.value })}
            >
              {jira.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </label>
        )}

        {selectedSite && jira.sites.length === 1 && (
          <p className="settings-site-name">Connected site: <a href={selectedSite.url} target="_blank" rel="noreferrer">{selectedSite.name}</a></p>
        )}

        <div className="settings-app-actions">
          {!jira.connected ? (
            <>
              <a className={`settings-primary-button ${!jira.configured || loading || busy ? "is-disabled" : ""}`} href={jira.configured && !loading && !busy ? appPath("auth/jira/start") : undefined} aria-disabled={!jira.configured || loading || busy} tabIndex={!jira.configured || loading || busy ? -1 : undefined}>
                Connect Jira
              </a>
              {!jira.configured && !loading && <span className="settings-hint">The app administrator needs to configure Jira OAuth.</span>}
            </>
          ) : (
            <>
              <a className="settings-secondary-button" href={appPath("auth/jira/start")}>Reconnect</a>
              <button className="settings-text-button" type="button" disabled={busy} onClick={() => void disconnectJira()}>
                Disconnect
              </button>
            </>
          )}
          <button className="settings-refresh" type="button" disabled={loading || busy} onClick={() => void loadConnections()}>
            Refresh status
          </button>
        </div>
      </section>

      <SlackCard />

      <section className="settings-app-card" aria-labelledby="outlook-app-title">
        <div className="settings-app-header">
          <div className="settings-app-icon settings-app-icon-outlook" aria-hidden="true">
            <img src={appPath("outlook-logo.png")} alt="" />
          </div>
          <div className="settings-app-name">
            <h2 id="outlook-app-title">Outlook</h2>
            <p>Tasks and events from your Outlook account</p>
          </div>
          <span className="settings-connection-state">Coming soon</span>
        </div>
      </section>

      <section className="settings-app-card" aria-labelledby="github-app-title">
        <div className="settings-app-header">
          <div className="settings-app-icon settings-app-icon-github" aria-hidden="true">
            <img src={appPath("github-logo.png")} alt="" />
          </div>
          <div className="settings-app-name">
            <h2 id="github-app-title">GitHub</h2>
            <p>Issues and pull requests from your repositories</p>
          </div>
          <span className="settings-connection-state">Coming soon</span>
        </div>
      </section>
    </section>
  );
}
