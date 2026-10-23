import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ago, ErrorBanner, Stat } from "../../components/ui";
import { api } from "../../lib/api";
import { refreshes } from "../Cluster/cluster";
import type { ClusterState } from "../Cluster/cluster";
import { signInError } from "./Connections";
import { rank, toItems } from "./rank";
import type { Source, SourceName } from "./sources";
import { titles } from "./sources";
import { isWaiting, TasksPanel, useDone } from "./Today";

// Today: your Slack, Jira and GitHub work in one ranked table, with the numbers that matter above it.
export function TodayPage({ sources, cluster, offset }: { sources: Source<any>[]; cluster: ClusterState | null; offset: number }) {
  const [slack, jira, github] = sources;
  const { isDone, markDone, undo } = useDone();
  const [jobId, setJobId] = useState<string | null>(null);
  const [signInErrors, setSignInErrors] = useState<string[]>([]);
  const lastRefreshAt = useRef(Date.now());

  const ranked = rank(toItems({ slack: slack.items, jira: jira.items, github: github.items }));
  const open = ranked.filter((item) => !isDone(item));
  const cleared = ranked.filter(isDone);
  const loading = sources.every((source) => source.status === "loading");
  // A visitor with no source connected sees sample rows, never counted as real work.
  const ready = sources.some((source) => source.status === "ready");
  const sample = !loading && !ready && open.length === 0;

  // The refresh this page asked the cluster for, and how far along it is.
  const job = cluster?.jobs.find((candidate) => candidate.id === jobId);
  const steps = cluster?.tasks.filter((task) => task.job === jobId) ?? [];
  const jobProgress = steps.length ? steps.reduce((sum, task) => sum + task.progress, 0) / steps.length : 0;
  const jobRunning = Boolean(job && job.doneAt === null && cluster?.orchestrator);
  const busy = sources.some((source) => source.syncing) || jobRunning;

  const startJob = useCallback(() => {
    api<{ job?: { id: string } }>("/api/cluster/refresh", {}).then(({ job }) => setJobId(job?.id ?? null), () => {});
  }, []);

  // The cluster runs a refresh job while this browser syncs each source itself.
  const refresh = useCallback(() => {
    if (busy) return;
    lastRefreshAt.current = Date.now();
    startJob();
    void slack.reload();
    void jira.reload();
    void github.reload();
  }, [busy, startJob, github.reload, jira.reload, slack.reload]);

  // Opening Today is a refresh too: the sources load on their own, and the
  // cluster gets a job, unless one is already running for Today to follow, or
  // the boards are busy with an Assistant job.
  const followed = useRef(false);
  useEffect(() => {
    if (followed.current || !cluster) return;
    followed.current = true;
    const running = refreshes(cluster.jobs).find((candidate) => candidate.doneAt === null);
    if (running) setJobId(running.id);
    else if (!cluster.jobs.some((candidate) => candidate.plan && candidate.doneAt === null)) startJob();
  }, [cluster, startJob]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errors = (Object.keys(titles) as SourceName[]).flatMap((name) => signInError(titles[name], params.get(name) ?? "") ?? []);
    if ((Object.keys(titles) as SourceName[]).some((name) => params.has(name))) window.history.replaceState({}, "", window.location.pathname);
    setSignInErrors(errors);
  }, []);

  // Refresh again after five minutes, but only while someone is looking.
  useEffect(() => {
    function refreshIfDue() {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt.current >= 5 * 60_000) refresh();
    }
    const timer = setInterval(refreshIfDue, 30_000);
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [refresh]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if (event.key === "r" && !typing && !event.metaKey && !event.ctrlKey) refresh();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);

  const items = sample || loading ? null : open;
  const waiting = items?.filter(isWaiting).length ?? 0;
  const connected = sources.filter((source) => source.status === "ready").length;
  const last = cluster ? refreshes(cluster.jobs).filter((entry) => entry.doneAt !== null).at(-1) : undefined;
  const now = Date.now() + offset;

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Today</h1>
          <p className="lede">Your Slack, Jira and GitHub work, ranked by what needs you first.</p>
        </div>
        <button
          className={busy ? "button primary refresh-button is-busy" : "button primary refresh-button"}
          type="button"
          onClick={refresh}
          disabled={busy}
          aria-keyshortcuts="r"
          style={{ "--done": jobRunning ? jobProgress : 0 } as CSSProperties}
        >
          <span>{busy ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>

      {signInErrors.map((message) => <ErrorBanner key={message} message={message} />)}
      {sources.map((source) => source.status === "error" && <ErrorBanner key={source.name} message={`${source.title}: ${source.error}`} onRetry={() => void source.reload()} />)}

      <ul className="stats is-4" aria-label="Summary">
        <Stat label="Open tasks" value={items ? String(items.length) : "—"} note={items ? "From Slack, Jira and GitHub" : "No source connected yet"} />
        <Stat label="Waiting on you" value={items ? String(waiting) : "—"} note={items ? "Direct messages and pull requests" : "No source connected yet"} tone={waiting ? "is-ember" : ""} />
        <Stat label="Sources connected" value={`${connected} / ${sources.length}`} note={connected === sources.length ? "Slack, Jira and GitHub" : "Connect the rest on Connections"} />
        <Stat
          label="Last refresh"
          value={last ? `${((last.doneAt! - last.queuedAt) / 1000).toFixed(1)} s` : "—"}
          note={jobRunning ? `Refreshing now, ${Math.round(jobProgress * 100)}% done` : last ? `On ${last.nodes} ${last.nodes === 1 ? "board" : "boards"}, ${ago(now - last.doneAt!)}` : "None finished yet"}
        />
      </ul>

      <div className="page-body">
        <TasksPanel items={open} cleared={cleared} loading={loading} sample={sample} onDone={markDone} onUndo={undo} onSaved={jira.reload} />
      </div>
    </div>
  );
}
