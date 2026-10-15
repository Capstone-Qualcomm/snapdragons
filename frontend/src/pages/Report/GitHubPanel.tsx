import { appPath } from "../../lib/urls";
import type { GitHubIssue } from "./useGitHubSource";
import type { Source } from "./useSlackSource";
import "./GitHubPanel.css";

type GitHubSource = Source<GitHubIssue>;

function SourceState({ source }: { source: GitHubSource }) {
  if (source.status === "loading") return <p className="panel-state">Loading GitHub issues…</p>;
  if (source.status === "unconfigured") return <p className="panel-state">GitHub sign-in is not set up on this server yet.</p>;
  if (source.status === "disconnected") return <p className="panel-state">GitHub is not connected. <a href={appPath("settings")}>Connect GitHub in Settings</a></p>;
  if (source.status === "disabled") return <p className="panel-state">GitHub is turned off for Report. <button type="button" onClick={() => void source.enable()}>Turn on</button></p>;
  if (source.status === "error") return <p className="panel-state is-error">{source.error} <button type="button" onClick={() => void source.reload()}>Retry</button></p>;
  if (source.items.length === 0) return <p className="panel-state">No open issues or PRs are assigned to you in GitHub.</p>;
  return null;
}

function GitHubRow({ issue }: { issue: GitHubIssue }) {
  return (
    <li className="work-row github-work-row">
      <img className="github-work-icon" src={appPath("github-logo.png")} alt="" aria-hidden="true" />
      <div className="work-main">
        <div className="work-meta">
          <span className="work-title">{issue.repository} #{issue.number}</span>
          <span className="work-sub">{issue.kind === "pull_request" ? "Pull request" : "Issue"}</span>
          <time dateTime={issue.updatedAt}>{new Date(issue.updatedAt).toLocaleDateString()}</time>
        </div>
        <p className="work-text">{issue.title}</p>
      </div>
      <a className="row-action" href={issue.url} target="_blank" rel="noreferrer">Open ↗</a>
    </li>
  );
}

export function GitHubPanel({ source }: { source: GitHubSource }) {
  return (
    <section className="work-panel github-work-panel">
      <header className="work-head">
        <h2>Assigned to you</h2>
        <span className="work-count">{source.status === "ready" ? source.items.length : "–"}</span>
        <span className="work-source">GitHub</span>
      </header>
      <SourceState source={source} />
      {source.status === "ready" && source.items.length > 0 && (
        <ul className="work-list">
          {source.items.map((issue) => <GitHubRow key={issue.id} issue={issue} />)}
        </ul>
      )}
    </section>
  );
}
