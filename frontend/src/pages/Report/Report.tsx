import { useCallback, useEffect, useState } from "react";
import { JiraReport } from "./jira/jiraReport";
import { Pipeline } from "./Pipeline";
import { SlackPanel } from "./SlackPanel";
import { GitHubPanel } from "./GitHubPanel";
import { useGitHubSource } from "./useGitHubSource";
import { useSlackSource } from "./useSlackSource";
import type { Source } from "./useSlackSource";
import "./Report.css";

export function ReportPage() {
  const slack = useSlackSource();
  const github = useGitHubSource();
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [jira, setJira] = useState<Source<unknown> | null>(null);

  const syncAll = useCallback(() => {
    setRefreshKey((key) => key + 1);
    void slack.reload();
    void github.reload();
  }, [github.reload, slack.reload]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const syncing = slack.status === "loading" || github.status === "loading";

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if (event.key === "r" && !typing && !event.metaKey && !event.ctrlKey) syncAll();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncAll]);

  return (
    <section className="report-view">
      <header className="report-bar">
        <h1>Report</h1>
        <span className="report-date">{new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        <button className="report-refresh" type="button" onClick={syncAll} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync all ↻"}
        </button>
      </header>
      <Pipeline slack={slack} github={github} jira={jira} now={now} />
      <div className="work-columns">
        <SlackPanel source={slack} now={now} />
        <div className="work-panel">
          <JiraReport refreshKey={refreshKey} onSourceChange={setJira} />
        </div>
        <GitHubPanel source={github} />
      </div>
      <footer className="report-keys">
        <span><kbd>r</kbd> sync everything</span>
        <span>times update every 30s</span>
      </footer>
    </section>
  );
}
