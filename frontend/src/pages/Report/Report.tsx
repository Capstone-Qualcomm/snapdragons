import { useEffect, useState } from "react";
import { Pipeline } from "./Pipeline";
import { JiraPanel, SlackPanel } from "./WorkPanels";
import type { JiraIssue, SlackMessage } from "./useSource";
import { useSource } from "./useSource";
import "./Report.css";

export function ReportPage() {
  const jira = useSource<JiraIssue>("jira", "issues");
  const slack = useSource<SlackMessage>("slack", "messages");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const syncing = jira.status === "loading" || slack.status === "loading";
  const { reload: reloadJira } = jira;
  const { reload: reloadSlack } = slack;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if (event.key === "r" && !typing && !event.metaKey && !event.ctrlKey) void Promise.all([reloadJira(), reloadSlack()]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reloadJira, reloadSlack]);

  return (
    <section className="report-view">
      <header className="report-bar">
        <h1>Report</h1>
        <span className="report-date">{new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        <button className="report-refresh" type="button" onClick={() => void Promise.all([jira.reload(), slack.reload()])} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync all ↻"}
        </button>
      </header>
      <Pipeline jira={jira} slack={slack} now={now} />
      <div className="work-columns">
        <SlackPanel source={slack} now={now} />
        <JiraPanel source={jira} now={now} />
      </div>
      <footer className="report-keys">
        <span><kbd>r</kbd>sync everything</span>
        <span>times update every 30s</span>
      </footer>
    </section>
  );
}
