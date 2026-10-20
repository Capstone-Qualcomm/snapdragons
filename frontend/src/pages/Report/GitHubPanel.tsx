import { Panel, RelativeTime, SourceLogo } from "../../components/ui";
import { SourceState } from "./SourceState";
import type { GitHubIssue } from "./useGitHubSource";
import type { Source } from "./useSource";

function GitHubRow({ issue }: { issue: GitHubIssue }) {
  return (
    <li className="item">
      <div className="item-main">
        <p className="item-meta">
          <strong title={issue.repository}>{issue.repository.split("/").at(-1)} #{issue.number}</strong>
          <span>{issue.kind === "pull_request" ? "Pull request" : "Issue"}</span>
          <RelativeTime value={issue.updatedAt} />
        </p>
        <p className="item-text">{issue.title}</p>
      </div>
      <a className="button small" href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open ${issue.repository} #${issue.number} on GitHub`}>Open</a>
    </li>
  );
}

export function GitHubPanel({ source }: { source: Source<GitHubIssue> }) {
  return (
    <Panel title="GitHub" icon={<SourceLogo name="github" />} count={source.status === "ready" ? source.items.length : null} id="report-github">
      <SourceState source={source} empty="No open issues or pull requests are assigned to you." />
      {source.status === "ready" && source.items.length > 0 && (
        <ul className="rows">
          {source.items.map((issue) => <GitHubRow key={issue.id} issue={issue} />)}
        </ul>
      )}
    </Panel>
  );
}
