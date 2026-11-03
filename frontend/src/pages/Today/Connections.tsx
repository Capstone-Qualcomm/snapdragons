import { useState } from "react";
import { SourceLogo, StatusDot } from "../../components/ui";
import { appPath } from "../../lib/urls";
import type { Source } from "./sources";

// Messages for the ?<source>=<outcome> the backend adds after sign-in. A
// successful one needs none: the source just shows as connected.
export function signInError(title: string, outcome: string): string | undefined {
  return {
    denied: `${title} access was not granted.`,
    error: `${title} could not be connected. Check the server configuration and try again.`,
    invalid_state: `The ${title} sign-in expired or could not be verified. Connect again.`,
    unconfigured: `${title} sign-in is not set up on this server.`,
  }[outcome];
}

// Integrations as cards: what each brings, whether it is
// connected, and the button that changes that. Nothing sits behind a menu.
export function ConnectionsPanel({ sources, counts }: { sources: Source<unknown>[]; counts: Record<string, number> }) {
  return (
    <ul className="integrations" aria-label="Connections" id="connections">
      {sources.map((source) => <Connection key={source.name} source={source} count={counts[source.name] ?? 0} />)}
    </ul>
  );
}

const states: Record<string, { badge: string; tone: string }> = {
  loading: { badge: "Checking", tone: "" },
  unconfigured: { badge: "Not set up", tone: "" },
  disconnected: { badge: "Not connected", tone: "" },
  disabled: { badge: "Turned off", tone: "is-warn" },
  error: { badge: "Error", tone: "is-bad" },
  ready: { badge: "Connected", tone: "is-ok" },
};

const ABOUT: Record<string, string> = {
  slack: "Direct messages and mentions that need a reply.",
  jira: "Tickets assigned to you, with status, sprint and story points.",
  github: "Pull requests waiting on your review and issues assigned to you.",
  outlook: "Unread messages from your Outlook inbox.",
};

// Disconnect asks once more, since connecting again means signing in again.
function Connection({ source, count }: { source: Source<unknown>; count: number }) {
  const { name, title, status } = source;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const start = appPath(`auth/${name}/start`);
  const detail = {
    loading: "Checking the connection…",
    unconfigured: "Sign-in is not set up on this server.",
    disconnected: ABOUT[name],
    disabled: "Its items are hidden from Today.",
    error: source.error,
    ready: `${source.account ? `${source.account} · ` : ""}${count} ${count === 1 ? "item" : "items"} on Today`,
  }[status];

  // One request at a time: the buttons stay off until it is answered.
  async function change(request: () => Promise<void>) {
    setConfirming(false);
    setBusy(true);
    await request();
    setBusy(false);
  }

  return (
    <li className={`integration is-${status}`}>
      <div className="integration-head">
        <span className="integration-logo"><SourceLogo name={name} /></span>
        <strong>{title}</strong>
        <span className={`badge ${states[status].tone}`}>
          {status === "loading" ? <StatusDot tone="busy" /> : status === "ready" ? <i className="badge-dot" /> : null}
          {states[status].badge}
        </span>
      </div>
      <p className="integration-detail">{detail}</p>
      <div className="integration-actions">
        {status === "unconfigured" && <button className="button" type="button" disabled title={`${title} sign-in is not set up on this server.`}>Connect {title}</button>}
        {status === "disconnected" && <a className="button" href={start}>Connect {title}</a>}
        {status === "disabled" && <button className="button" type="button" disabled={busy} onClick={() => void change(() => source.setEnabled(true))}>Turn on {title}</button>}
        {status === "error" && <button className="button" type="button" onClick={() => void source.reload()}>Retry</button>}
        {status === "error" && <a className="button quiet" href={start}>Reconnect</a>}
        {status === "ready" && <button className="button" type="button" aria-label={`Turn off ${title}`} disabled={busy} onClick={() => void change(() => source.setEnabled(false))}>Turn off</button>}
        {(status === "ready" || status === "error") && (confirming ? (
          <>
            <button className="button is-danger" type="button" aria-label={`Confirm disconnect ${title}`} disabled={busy} onClick={() => void change(source.disconnect)}>Confirm disconnect</button>
            <button className="button quiet" type="button" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button className="button quiet" type="button" aria-label={`Disconnect ${title}`} disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>
        ))}
      </div>
    </li>
  );
}
