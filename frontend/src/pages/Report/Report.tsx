import { useCallback, useEffect, useState } from "react";
import { JiraReport } from "./jira/jiraReport";
import { Pipeline } from "./Pipeline";
import { PriorityList } from "./PriorityList";
import { SlackPanel } from "./SlackPanel";
import { useSlackSource } from "./useSlackSource";
import type { JiraIssue } from "./jira/jiraService";
import "./Report.css";

export function ReportPage() {
  const slack = useSlackSource();
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [jiraCount, setJiraCount] = useState(0);
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([]);

  const syncAll = useCallback(() => {
    setRefreshKey((key) => key + 1);
    void slack.reload();
  }, [slack.reload]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const syncing = slack.status === "loading";

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if (event.key === "r" && !typing && !event.metaKey && !event.ctrlKey) syncAll();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncAll]);

  // Only include Slack in the pipeline while Jira reports its own status internally.
  return (
    <section className="report-view">
      <header className="report-bar">
        <h1>Report</h1>
        <span className="report-date">{new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        <button className="report-refresh" type="button" onClick={syncAll} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync all ↻"}
        </button>
      </header>
      <Pipeline slack={slack} jiraCount={jiraCount} now={now} />
      <PriorityList issues={jiraIssues} slack={slack} />
      <div className="work-columns">
        <SlackPanel source={slack} now={now} />
        <div className="work-panel">
          <JiraReport refreshKey={refreshKey} onCountChange={setJiraCount} onItemsChange={setJiraIssues} />
        </div>
      </div>
      <footer className="report-keys">
        <span><kbd>r</kbd> sync everything</span>
        <span>times update every 30s</span>
      </footer>
    </section>
  );
}
