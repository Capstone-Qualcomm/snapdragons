import { useCallback, useEffect, useState } from "react";
import { apiPath, appPath } from "../../lib/urls";
import "./SlackCard.css";

type SlackConnection = {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  team: string | null;
};

const emptyConnection: SlackConnection = { configured: false, connected: false, enabled: false, connectedAt: null, team: null };

const callbackMessages: Record<string, string> = {
  connected: "Slack is connected. Mentions and unanswered DMs are ready in Report.",
  denied: "Slack access was not granted.",
  error: "Slack could not be connected. Check the server configuration and try again.",
  invalid_state: "The Slack sign-in expired or could not be verified. Please connect again.",
  unconfigured: "Slack sign-in is not configured on this server yet.",
};

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function SlackCard() {
  const [slack, setSlack] = useState(emptyConnection);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });

  const loadConnection = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(apiPath("/api/slack/connection"), { cache: "no-store" });
      const result = await readJson<{ slack?: SlackConnection; error?: string }>(response);
      if (!response.ok || !result?.slack) throw new Error(result?.error ?? "Could not load Slack status.");
      setSlack(result.slack);
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Could not load Slack status.", isError: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("slack");
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
      const result = await readJson<{ slack?: SlackConnection; error?: string }>(response);
      if (!response.ok || !result?.slack) throw new Error(result?.error ?? "Could not update the Slack connection.");
      setSlack(result.slack);
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Could not update the Slack connection.", isError: true });
    } finally {
      setBusy(false);
    }
  }

  const blocked = !slack.configured || loading || busy;

  return (
    <section className="settings-app-card" aria-labelledby="slack-app-title">
      <div className="settings-app-header">
        <div className="settings-app-icon settings-app-icon-slack" aria-hidden="true">
          <svg width={20} height={20} viewBox="0 0 122.8 122.8" aria-hidden="true">
            <path fill="#e01e5a" d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" />
            <path fill="#36c5f0" d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" />
            <path fill="#2eb67d" d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" />
            <path fill="#ecb22e" d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" />
          </svg>
        </div>
        <div className="settings-app-name">
          <h2 id="slack-app-title">Slack</h2>
          <p>
            {slack.team ? `Connected to ${slack.team}` : "Mentions and unanswered DMs from the last day"}
            {slack.connectedAt && ` · since ${new Date(slack.connectedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`}
          </p>
        </div>
        <span className={`settings-connection-state ${slack.connected ? "is-connected" : ""}`}>
          {loading ? "Checking…" : slack.connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {message.text && <p className={`slack-card-notice ${message.isError ? "is-error" : ""}`} role={message.isError ? "alert" : "status"}>{message.text}</p>}

      <div className="slack-access">
        <span className="slack-access-label">Reads</span>
        <span className="slack-access-chip">Messages that mention you</span>
        <span className="slack-access-chip">Your direct messages</span>
        <span className="slack-access-chip">Names of people</span>
      </div>

      <div className="settings-app-controls">
        <div className="settings-enable-copy">
          <span className="settings-enable-title">Include Slack in Report</span>
          <span className="settings-enable-description">
            {slack.enabled ? "Slack messages appear in your report." : "Slack messages are not currently included."}
          </span>
        </div>
        <label className="settings-toggle">
          <span className="visually-hidden">Enable Slack messages in Report</span>
          <input
            type="checkbox"
            checked={slack.enabled}
            disabled={loading || busy || !slack.connected}
            onChange={(event) => void post("/api/slack/connection/enabled", { enabled: event.target.checked })}
          />
          <span className="settings-toggle-track" aria-hidden="true" />
        </label>
      </div>

      <div className="settings-app-actions">
        {!slack.connected ? (
          <>
            <a className={`settings-primary-button ${blocked ? "is-disabled" : ""}`} href={blocked ? undefined : appPath("auth/slack/start")} aria-disabled={blocked} tabIndex={blocked ? -1 : undefined}>
              Connect Slack
            </a>
            {!slack.configured && !loading && <span className="settings-hint">The app administrator needs to configure Slack OAuth.</span>}
          </>
        ) : (
          <>
            <a className="settings-secondary-button" href={appPath("auth/slack/start")}>Reconnect</a>
            <button className="settings-text-button" type="button" disabled={busy} onClick={() => void post("/api/slack/connection/disconnect", {})}>
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
