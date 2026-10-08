import { useCallback, useEffect, useState } from "react";
import "./Report.css";

type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  priority: string;
  issueType: string;
  updated: string | null;
  url: string;
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
            {issues.map((issue) => (
              <article className="report-issue" key={issue.key}>
                <div className="report-issue-main">
                  <a className="report-issue-key" href={issue.url} target="_blank" rel="noreferrer">{issue.key}</a>
                  <h3>{issue.summary}</h3>
                  <span className="report-issue-type">{issue.issueType}</span>
                </div>
                <div className="report-issue-meta">
                  <span className="report-status">{issue.status}</span>
                  <span>{issue.priority}</span>
                  {issue.updated && <time dateTime={issue.updated}>{new Date(issue.updated).toLocaleDateString()}</time>}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
