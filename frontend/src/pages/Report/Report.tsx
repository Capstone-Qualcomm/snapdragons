import { useCallback, useEffect, useRef, useState } from "react";
import { JiraReport } from "./jira/jiraReport";
import { Pipeline } from "./Pipeline";
import { SlackPanel } from "./SlackPanel";
import { useSlackSource } from "./useSlackSource";
import "./Report.css";

export function ReportPage() {
  const slack = useSlackSource();
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [jiraCount, setJiraCount] = useState(0);
  const [jiraLoading, setJiraLoading] = useState(true);
  const lastRefreshAt = useRef(Date.now());
  const syncing = slack.status === "loading" || jiraLoading;

  const syncAll = useCallback(() => {
    if (syncing) return;
    lastRefreshAt.current = Date.now();
    setRefreshKey((key) => key + 1);
    void slack.reload();
  }, [slack.reload, syncing]);

  useEffect(() => {
    function refreshIfDue() {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt.current >= 5 * 60_000) syncAll();
    }
    const timer = setInterval(() => {
      setNow(Date.now());
      refreshIfDue();
    }, 30_000);
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [syncAll]);

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
      <div className="work-columns">
        <SlackPanel source={slack} now={now} />
        <div className="work-panel">
          <JiraReport refreshKey={refreshKey} onCountChange={setJiraCount} onLoadingChange={setJiraLoading} />
        </div>
      </div>
      <footer className="report-keys">
        <span><kbd>r</kbd> sync everything</span>
        <span>data refreshes every 5m while open · times update every 30s</span>
      </footer>
    </section>
  );
}
