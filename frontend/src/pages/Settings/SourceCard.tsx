import { useCallback, useEffect, useState } from "react";
import { SourceLogo, StatusDot } from "../../components/ui";
import type { Tone } from "../../components/ui";
import { api } from "../../lib/api";
import { appPath } from "../../lib/urls";

type Connection = {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  connectedAt: string | null;
  team?: string | null;
  user?: string | null;
  cloudId?: string | null;
  sites?: Array<{ id: string; name: string; url: string }>;
};

type SourceCardProps = { source: "jira" | "slack" | "github"; name: string };

// Messages for the ?<source>=<outcome> the backend adds after sign-in.
function callbackMessage(name: string, outcome: string): string | undefined {
  return {
    connected: `${name} is connected.`,
    denied: `${name} access was not granted.`,
    error: `${name} could not be connected. Check the server configuration and try again.`,
    invalid_state: `The ${name} sign-in expired or could not be verified. Connect again.`,
    unconfigured: `${name} sign-in is not set up on this server.`,
  }[outcome];
}

export function SourceCard({ source, name }: SourceCardProps) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  // The first check failed, so there is no state to show until Retry.
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setConnection((await api<Record<string, Connection>>(`/api/${source}/connection`))[source]);
    } catch (cause) {
      setFailed(true);
      setMessage({ text: (cause as Error).message, isError: true });
    }
  }, [source]);

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get(source);
    const text = outcome && callbackMessage(name, outcome);
    if (text) {
      setMessage({ text, isError: outcome !== "connected" });
      window.history.replaceState({}, "", window.location.pathname);
    }
    void load();
  }, [source, name, load]);

  async function post(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setMessage({ text: "", isError: false });
    try {
      setConnection((await api<Record<string, Connection>>(`/api/${source}/connection/${path}`, body))[source]);
      if (path === "disconnect") setMessage({ text: `${name} is disconnected from Continuum.`, isError: false });
    } catch (cause) {
      setMessage({ text: (cause as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  const connected = connection?.connected ?? false;
  const account = connection?.team ?? connection?.user ?? connection?.sites?.find((site) => site.id === connection.cloudId)?.name;
  const [tone, state]: [Tone, string] = !connection ? (failed ? ["bad", "Not checked"] : ["busy", "Checking"])
    : connected ? (connection.enabled ? ["ok", "Connected"] : ["warn", "Turned off"])
    : connection.configured ? ["off", "Not connected"] : ["off", "Not set up"];

  return (
    <li className="source-row" aria-labelledby={`${source}-row-title`}>
      <SourceLogo name={source} />
      <div className="source-name">
        <h3 id={`${source}-row-title`}>{name}</h3>
        {connected && account && <span>{account}</span>}
      </div>
      <span className="source-state"><StatusDot tone={tone} />{state}</span>
      <label className="switch">
        <input
          type="checkbox"
          checked={connection?.enabled ?? false}
          disabled={busy || !connected}
          onChange={(event) => void post("enabled", { enabled: event.target.checked })}
        />
        <span className="switch-track" aria-hidden="true" />
        Show in Report
      </label>
      <div className="source-actions">
        {connected ? (
          <>
            <a className="button small" href={appPath(`auth/${source}/start`)}>Reconnect</a>
            <button className="button small" type="button" disabled={busy} onClick={() => void post("disconnect")}>Disconnect</button>
          </>
        ) : failed ? (
          <button className="button small" type="button" onClick={() => { setMessage({ text: "", isError: false }); void load(); }}>Retry</button>
        ) : connection?.configured && (
          <a className="button small primary" href={appPath(`auth/${source}/start`)}>Connect {name}</a>
        )}
      </div>
      {message.text && <p className={message.isError ? "source-message is-error" : "source-message"} role={message.isError ? "alert" : "status"}>{message.text}</p>}
    </li>
  );
}
