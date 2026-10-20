import { useCallback, useEffect, useRef } from "react";
import { PageHeader, relative, useNow } from "../../components/ui";
import { GitHubPanel } from "./GitHubPanel";
import { JiraReport } from "./jira/jiraReport";
import { useJiraSource } from "./jira/jiraService";
import { SlackPanel } from "./SlackPanel";
import { useGitHubSource } from "./useGitHubSource";
import { useSlackSource } from "./useSlackSource";
import "./Report.css";

export function ReportPage() {
  const slack = useSlackSource();
  const jira = useJiraSource();
  const github = useGitHubSource();
  const now = useNow();
  const lastRefreshAt = useRef(Date.now());
  const sources = [slack, jira, github];
  const syncing = sources.some((source) => source.status === "loading" || source.syncing);
  const loadedTimes = sources.map((source) => source.loadedAt).filter((time) => time !== null);
  const syncedAt = loadedTimes.length ? Math.min(...loadedTimes) : null;

  const syncAll = useCallback(() => {
    if (syncing) return;
    lastRefreshAt.current = Date.now();
    void slack.reload();
    void jira.reload();
    void github.reload();
  }, [github.reload, jira.reload, slack.reload, syncing]);

  // Sync again after five minutes, but only while someone is looking.
  useEffect(() => {
    function refreshIfDue() {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt.current >= 5 * 60_000) syncAll();
    }
    const timer = setInterval(refreshIfDue, 30_000);
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

  return (
    <>
      <PageHeader title="Report">
        {syncedAt !== null && <span className="report-synced">Synced {relative(syncedAt, now)}</span>}
        <button className="button primary" type="button" onClick={syncAll} disabled={syncing} aria-keyshortcuts="r">
          {syncing ? "Syncing…" : "Sync all"}
        </button>
      </PageHeader>
      <div className="block report-columns">
        <SlackPanel source={slack} />
        <JiraReport source={jira} />
        <GitHubPanel source={github} />
      </div>
    </>
  );
}
