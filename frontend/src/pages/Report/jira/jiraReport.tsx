import { useCallback, useEffect, useState } from "react";
import "../report.css";
import { getAssignedJiraIssues, getJiraConnection, getJiraTransitions, updateJiraIssue } from "./jiraService";
import type { JiraIssue, JiraTransition } from "./jiraService";

type IssueDraft = { description: string; storyPointEstimate: string; transitionId: string };
const storyPointOptions = ["", "1", "2", "3", "5", "8", "13", "21"];

export function JiraReport() {
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [expandedIssues, setExpandedIssues] = useState<Set<string>>(() => new Set());
  const [transitions, setTransitions] = useState<Record<string, JiraTransition[]>>({});
  const [transitionErrors, setTransitionErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, IssueDraft>>({});
  const [savingIssues, setSavingIssues] = useState<Set<string>>(() => new Set());
  const [saveMessages, setSaveMessages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("");

  const loadIssues = useCallback(async () => {
    setLoading(true);
    setError("");
    setConnectionMessage("");
    let connectionChecked = false;
    try {
      const connection = await getJiraConnection();
      connectionChecked = true;

      if (!connection.connected) {
        setIssues([]);
        setConnectionMessage("No apps are connected to pull from. Connect an app in Settings.");
        return;
      }

      if (!connection.enabled) {
        setIssues([]);
        setConnectionMessage("Jira is connected but disabled. Enable it in Settings to pull tasks.");
        return;
      }

      setIssues(await getAssignedJiraIssues());
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

  function initialDraft(issue: JiraIssue): IssueDraft {
    return {
      description: issue.description,
      storyPointEstimate: issue.storyPointEstimate == null ? "" : String(issue.storyPointEstimate),
      transitionId: "",
    };
  }

  function updateDraft(issue: JiraIssue, change: Partial<IssueDraft>) {
    setDrafts((current) => ({
      ...current,
      [issue.key]: { ...(current[issue.key] ?? initialDraft(issue)), ...change },
    }));
  }

  async function toggleIssue(issue: JiraIssue) {
    const key = issue.key;
    setExpandedIssues((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (expandedIssues.has(key) || transitions[key]) return;

    try {
      const availableTransitions = await getJiraTransitions(key);
      setTransitions((current) => ({ ...current, [key]: availableTransitions }));
    } catch (cause) {
      setTransitionErrors((current) => ({ ...current, [key]: cause instanceof Error ? cause.message : "Could not load available Jira statuses." }));
    }
  }

  async function saveIssue(issue: JiraIssue) {
    const draft = drafts[issue.key] ?? initialDraft(issue);
    setSavingIssues((current) => new Set(current).add(issue.key));
    setSaveMessages((current) => ({ ...current, [issue.key]: "" }));
    try {
      const estimate = draft.storyPointEstimate.trim();
      await updateJiraIssue(issue.key, {
        description: draft.description,
        storyPointEstimate: estimate === "" ? null : Number(estimate),
        transitionId: draft.transitionId,
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[issue.key];
        return next;
      });
      setSaveMessages((current) => ({ ...current, [issue.key]: "Changes saved to Jira." }));
      await loadIssues();
    } catch (cause) {
      setSaveMessages((current) => ({ ...current, [issue.key]: cause instanceof Error ? cause.message : "Could not save Jira changes." }));
    } finally {
      setSavingIssues((current) => {
        const next = new Set(current);
        next.delete(issue.key);
        return next;
      });
    }
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
              const draft = drafts[issue.key] ?? initialDraft(issue);
              const saving = savingIssues.has(issue.key);
              return (
                <article className="report-issue" key={issue.key}>
                  <div className="report-issue-row">
                    <button
                      className={`report-issue-expand ${expanded ? "is-expanded" : ""}`}
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${issue.key} details`}
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      onClick={() => void toggleIssue(issue)}
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
                      {issue.updated && <time dateTime={issue.updated}>{new Date(issue.updated).toLocaleDateString()}</time>}
                    </div>
                  </div>
                  <div className="report-issue-details" id={detailsId} hidden={!expanded}>
                    <section className="report-detail-field report-detail-description">
                      <h4>Description</h4>
                        <textarea
                          aria-label={`Description for ${issue.key}`}
                          value={draft.description}
                          onChange={(event) => updateDraft(issue, { description: event.target.value })}
                          rows={4}
                        />
                    </section>
                    <section className="report-detail-field report-detail-static-sprint">
                      <h4>Sprint</h4>
                      <p className="report-detail-value">{issue.sprints.length ? issue.sprints.join(", ") : "None"}</p>
                    </section>
                    <section className="report-detail-field report-detail-static-labels">
                      <h4>Labels</h4>
                      {issue.labels.length ? <div className="report-labels">{issue.labels.map((label) => <span key={label}>{label}</span>)}</div> : <p className="report-detail-value">None</p>}
                    </section>
                    <section className="report-detail-field report-detail-editable-estimate">
                      <h4>Story point estimate</h4>
                      <select
                        aria-label={`Story point estimate for ${issue.key}`}
                        value={draft.storyPointEstimate}
                        onChange={(event) => updateDraft(issue, { storyPointEstimate: event.target.value })}
                      >
                        <option value="">Not set</option>
                        {storyPointOptions.slice(1).map((points) => <option key={points} value={points}>{points}</option>)}
                      </select>
                    </section>
                    <section className="report-detail-field report-detail-static-reporter">
                      <h4>Reporter</h4>
                      <p className="report-detail-value">{issue.reporter}</p>
                    </section>
                    <section className="report-detail-field report-detail-editable-status">
                      <h4>Status</h4>
                      <select
                        aria-label={`New status for ${issue.key}`}
                        value={draft.transitionId}
                        onChange={(event) => updateDraft(issue, { transitionId: event.target.value })}
                      >
                        <option value="">Keep current status ({issue.status})</option>
                        {(transitions[issue.key] ?? []).map((transition) => <option key={transition.id} value={transition.id}>{transition.status}</option>)}
                      </select>
                      {transitionErrors[issue.key] && <p className="report-edit-error">{transitionErrors[issue.key]}</p>}
                    </section>
                    <div className="report-edit-actions report-detail-editable-actions">
                      <button type="button" onClick={() => void saveIssue(issue)} disabled={saving || loading}>
                        {saving ? "Saving…" : "Save changes"}
                      </button>
                      {saveMessages[issue.key] && <p className={saveMessages[issue.key].startsWith("Changes saved") ? "report-edit-success" : "report-edit-error"} role="status">{saveMessages[issue.key]}</p>}
                    </div>
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
