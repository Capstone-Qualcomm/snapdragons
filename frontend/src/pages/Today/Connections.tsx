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

// Slack, Jira and GitHub as integration cards: what each brings, whether it is
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
};

function Connection({ source, count }: { source: Source<unknown>; count: number }) {
  const { name, title, status } = source;
  const start = appPath(`auth/${name}/start`);
  const detail = {
    loading: "Checking the connection…",
    unconfigured: "Sign-in is not set up on this server.",
    disconnected: ABOUT[name],
    disabled: "Its items are hidden from Today.",
    error: source.error,
    ready: `${source.account ? `${source.account} · ` : ""}${count} ${count === 1 ? "item" : "items"} on Today`,
  }[status];

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
        {status === "disabled" && <button className="button" type="button" onClick={() => void source.setEnabled(true)}>Turn on {title}</button>}
        {status === "error" && <button className="button" type="button" onClick={() => void source.reload()}>Retry</button>}
        {status === "error" && <a className="button quiet" href={start}>Reconnect</a>}
        {status === "ready" && <button className="button" type="button" aria-label={`Turn off ${title}`} onClick={() => void source.setEnabled(false)}>Turn off</button>}
        {(status === "ready" || status === "error") && <button className="button quiet" type="button" aria-label={`Disconnect ${title}`} onClick={() => void source.disconnect()}>Disconnect</button>}
      </div>
    </li>
  );
}
