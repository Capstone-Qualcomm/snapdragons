import { useCallback, useEffect, useState } from "react";
import "./Report.css";

type JiraRelatedIssue = {
  key: string;
  summary: string;
  status: string;
  url: string;
  relation?: string;
};

type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  priority: string;
  issueType: string;
  updated: string | null;
  url: string;
  description: string;
  subtasks: JiraRelatedIssue[];
  linkedWorkItems: JiraRelatedIssue[];
  parent: JiraRelatedIssue | null;
  sprints: string[];
  labels: string[];
  storyPointEstimate: number | string | null;
  reporter: string;
};

type JiraConnectionResponse = {
  jira?: { connected?: boolean; enabled?: boolean };
  error?: string;
};

type JiraIssuesResponse = {
  issues?: JiraIssue[];
  error?: string;
};

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function ReportPage() {
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [expandedIssues, setExpandedIssues] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("");

  const loadIssues = useCallback(async () => {
    setLoading(true);
    setError("");
    setConnectionMessage("");
    let connectionChecked = false;
    try {
      const connectionResponse = await fetch("/api/jira/connection", { cache: "no-store" });
      const connectionResult = await readJson<JiraConnectionResponse>(connectionResponse);
      if (!connectionResponse.ok) {
        throw new Error(connectionResult?.error ?? "Could not check connected apps. Please try again.");
      }
      if (typeof connectionResult?.jira?.connected !== "boolean" || typeof connectionResult.jira.enabled !== "boolean") {
        throw new Error("Could not check connected apps. Please try again.");
      }
      connectionChecked = true;

      if (!connectionResult.jira.connected) {
        setIssues([]);
        setConnectionMessage("No apps are connected to pull from. Connect an app in Settings.");
        return;
      }

      if (!connectionResult.jira.enabled) {
        setIssues([]);
        setConnectionMessage("Jira is connected but disabled. Enable it in Settings to pull tasks.");
        return;
      }

      const response = await fetch("/api/jira/issues", { cache: "no-store" });
      const result = await readJson<JiraIssuesResponse>(response);
      if (!response.ok) throw new Error(result?.error ?? "Could not load tasks right now. Please try again.");
      if (!Array.isArray(result?.issues)) throw new Error("Could not load tasks right now. Please try again.");
      setIssues(result.issues);
    } catch (cause) {
      if (!connectionChecked) {
        setIssues([]);
        setConnectionMessage("No apps are connected to pull from. Connect an app in Settings.");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not load Jira tasks.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  function toggleIssue(key: string) {
    setExpandedIssues((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section className="report-view">
      <div className="report-panel">
        <div className="report-panel-header">
          <div className="report-title">
            <span className="node-mark" />
            <h2>Report</h2>
            {!loading && !error && <span className="report-count">{issues.length} assigned</span>}
          </div>
          <button className="report-refresh" type="button" onClick={() => void loadIssues()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {loading ? (
          <div className="report-empty" role="status"><p>Loading assigned Jira tasks…</p></div>
        ) : error ? (
          <div className="report-empty report-error" role="alert">
            <p>{error}</p>
            <a href="/settings">Open Settings</a>
          </div>
        ) : connectionMessage ? (
          <div className="report-empty report-error" role="status">
            <p>{connectionMessage}</p>
            <a href="/settings">Open Settings</a>
          </div>
        ) : issues.length === 0 ? (
          <div className="report-empty"><p>No assigned Jira tasks</p></div>
        ) : (
          <div className="report-issues">
            {issues.map((issue) => {
              const expanded = expandedIssues.has(issue.key);
              const detailsId = `issue-details-${issue.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
              return (
                <article className="report-issue" key={issue.key}>
                  <div className="report-issue-row">
                    <button
                      className={`report-issue-expand ${expanded ? "is-expanded" : ""}`}
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${issue.key} details`}
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      onClick={() => toggleIssue(issue.key)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
                    </button>
                    <img className="report-issue-logo" src="/jira-logo.png" alt="" aria-hidden="true" />
                    <div className="report-issue-main">
                      <div className="report-issue-title">
                        <span className="report-issue-type">{issue.issueType}</span>
                        <span className="report-issue-separator" aria-hidden="true">-</span>
                        <a className="report-issue-key" href={issue.url} target="_blank" rel="noreferrer">{issue.key}</a>
                        <span className="report-issue-separator" aria-hidden="true">-</span>
                        <h3>{issue.summary}</h3>
                      </div>
                    </div>
                    <div className="report-issue-meta">
                      <span className="report-status">{issue.status}</span>
                      <span>{issue.priority}</span>
                      {issue.updated && <time dateTime={issue.updated}>{new Date(issue.updated).toLocaleDateString()}</time>}
                    </div>
                  </div>
                  <div className="report-issue-details" id={detailsId} hidden={!expanded}>
                    <section className="report-detail-field report-detail-description">
                      <h4>Description</h4>
                      <p className="report-detail-description-text">{issue.description || "No description provided."}</p>
                    </section>
                    <section className="report-detail-field">
                      <h4>Subtasks</h4>
                      {issue.subtasks.length ? (
                        <ul className="report-related-list">
                          {issue.subtasks.map((item) => <li key={item.key}><a href={item.url} target="_blank" rel="noreferrer">{item.key}</a><span>{item.summary}</span><small>{item.status}</small></li>)}
                        </ul>
                      ) : <p className="report-detail-value">None</p>}
                    </section>
                    <section className="report-detail-field">
                      <h4>Linked work items</h4>
                      {issue.linkedWorkItems.length ? (
                        <ul className="report-related-list">
                          {issue.linkedWorkItems.map((item) => <li key={`${item.relation}-${item.key}`}><span className="report-related-relation">{item.relation}</span><a href={item.url} target="_blank" rel="noreferrer">{item.key}</a><span>{item.summary}</span></li>)}
                        </ul>
                      ) : <p className="report-detail-value">None</p>}
                    </section>
                    <section className="report-detail-field">
                      <h4>Parent</h4>
                      {issue.parent ? <p className="report-detail-value"><a href={issue.parent.url} target="_blank" rel="noreferrer">{issue.parent.key}</a><span> — {issue.parent.summary}</span></p> : <p className="report-detail-value">None</p>}
                    </section>
                    <section className="report-detail-field">
                      <h4>Sprint</h4>
                      <p className="report-detail-value">{issue.sprints.length ? issue.sprints.join(", ") : "None"}</p>
                    </section>
                    <section className="report-detail-field">
                      <h4>Labels</h4>
                      {issue.labels.length ? <div className="report-labels">{issue.labels.map((label) => <span key={label}>{label}</span>)}</div> : <p className="report-detail-value">None</p>}
                    </section>
                    <section className="report-detail-field">
                      <h4>Story point estimate</h4>
                      <p className="report-detail-value">{issue.storyPointEstimate ?? "Not set"}</p>
                    </section>
                    <section className="report-detail-field">
                      <h4>Priority</h4>
                      <p className="report-detail-value">{issue.priority}</p>
                    </section>
                    <section className="report-detail-field">
                      <h4>Reporter</h4>
                      <p className="report-detail-value">{issue.reporter}</p>
                    </section>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
