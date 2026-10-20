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

// One source in Today's header: what it can do next, or, once it is
// connected, how many items it brought, with its other controls in a menu.
export function Connection({ source, count }: { source: Source<unknown>; count: number }) {
  const { name, title, status } = source;
  const start = appPath(`auth/${name}/start`);
  const logo = <SourceLogo name={name} />;

  switch (status) {
    case "loading":
      return <span className="source-pill">{logo}{title}<StatusDot tone="busy" /></span>;
    case "unconfigured":
      return <button className="button small source-pill" type="button" disabled title={`${title} sign-in is not set up on this server.`}>{logo}Connect {title}</button>;
    case "disconnected":
      return <a className="button small primary source-pill" href={start}>{logo}Connect {title}</a>;
    case "disabled":
      return <button className="button small source-pill" type="button" onClick={() => void source.setEnabled(true)}>{logo}Turn on {title}</button>;
    case "error":
    case "ready":
      return (
        <details className="source-menu">
          <summary className={`source-pill is-${status}`} aria-label={`${title} menu`}>
            {logo}
            {title}
            {status === "error" ? <StatusDot tone="bad" /> : <span className="count">{count}</span>}
            {source.syncing && <StatusDot tone="busy" />}
          </summary>
          <div className="menu">
            {source.account && <p className="menu-account">{source.account}</p>}
            {status === "error" && <button className="menu-item" type="button" onClick={() => void source.reload()}>Retry</button>}
            <button className="menu-item" type="button" onClick={() => void source.setEnabled(false)}>Turn off</button>
            <a className="menu-item" href={start}>Reconnect</a>
            <button className="menu-item" type="button" onClick={() => void source.disconnect()}>Disconnect</button>
          </div>
        </details>
      );
  }
}
