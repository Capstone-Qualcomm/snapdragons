import { useEffect, useState } from "react";
import { JiraReport } from "./jira/jiraReport";
import { Pipeline } from "./Pipeline";
import { SlackPanel } from "./SlackPanel";
import { useSlackSource } from "./useSlackSource";
import "./Report.css";

export function ReportPage() {
  const slack = useSlackSource();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const syncing = slack.status === "loading";

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if (event.key === "r" && !typing && !event.metaKey && !event.ctrlKey) void slack.reload();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slack.reload]);

  // Only include Slack in the pipeline while Jira reports its own status internally.
  return (
    <section className="report-view">
      <header className="report-bar">
        <h1>Report</h1>
        <span className="report-date">{new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        <button className="report-refresh" type="button" onClick={() => void slack.reload()} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync all ↻"}
        </button>
      </header>
      <Pipeline slack={slack} now={now} />
      <div className="work-columns">
        <SlackPanel source={slack} now={now} />
        <div className="work-panel">
          <JiraReport />
        </div>
      </div>
      <footer className="report-keys">
        <span><kbd>r</kbd> sync everything</span>
        <span>times update every 30s</span>
      </footer>
    </section>
  );
}