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

const off = (source: Source<any>) => ["unconfigured", "disconnected", "disabled"].includes(source.status);

// Today: your Slack, Jira, GitHub and Outlook work in one ranked table, with the numbers that matter above it.
// It stays mounted while another page is open, so an open Jira edit survives; active is whether it is on screen.
export function TodayPage({ sources, cluster, failed, offset, active }: { sources: Source<any>[]; cluster: ClusterState | null; failed: boolean; offset: number; active: boolean }) {
  const [slack, jira, github, outlook] = sources;
  const { isDone, markDone, undo } = useDone();
  const [jobId, setJobId] = useState<string | null>(null);
  const [signInErrors, setSignInErrors] = useState<string[]>([]);
  const [handledOutlookIds, setHandledOutlookIds] = useState<Set<string>>(() => new Set());
  const lastRefreshAt = useRef(Date.now());

  const ranked = rank(toItems({ slack: slack.items, jira: jira.items, github: github.items, outlook: outlook.items }))
    .filter((item) => item.source !== "outlook" || !handledOutlookIds.has(item.data.id));
  const open = ranked.filter((item) => !isDone(item));
  const cleared = ranked.filter(isDone);
  // A visitor with no source connected sees sample rows, never counted as real work.
  const sample = sources.every(off);
  const loading = !sample && open.length === 0 && sources.some((source) => source.status === "loading");
  // The all-clear needs every source that is on to have answered.
  const checked = sources.every((source) => off(source) || source.status === "ready");

  // The refresh this page asked the cluster for, and how far along it is.
  const job = cluster?.jobs.find((candidate) => candidate.id === jobId);
  const steps = cluster?.tasks.filter((task) => task.job === jobId) ?? [];
  const jobProgress = steps.length ? steps.reduce((sum, task) => sum + task.progress, 0) / steps.length : 0;
  // An unreachable cluster leaves its last state behind; it must not hold up the sources' own syncs.
  const jobRunning = Boolean(job && job.doneAt === null && cluster?.orchestrator && !failed);
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
    void outlook.reload();
  }, [busy, startJob, github.reload, jira.reload, outlook.reload, slack.reload]);

  const deleteOutlook = useCallback(async (messageId: string) => {
    await api(`/api/outlook/messages/${encodeURIComponent(messageId)}/delete`, {});
    // Graph can briefly return a just-updated message in a list response. Hide it
    // once the action succeeds and keep it hidden until a later sync confirms it is gone.
    setHandledOutlookIds((current) => new Set(current).add(messageId));
    await outlook.reload();
  }, [outlook.reload]);

  const replyToOutlook = useCallback(async (messageId: string, comment: string) => {
    const result = await api<{ markedRead: boolean }>(`/api/outlook/messages/${encodeURIComponent(messageId)}/reply`, { comment });
    if (result.markedRead) setHandledOutlookIds((current) => new Set(current).add(messageId));
    await outlook.reload();
    return result.markedRead;
  }, [outlook.reload]);

  useEffect(() => {
    const currentIds = new Set(outlook.items.map((item) => item.id));
    setHandledOutlookIds((current) => {
      const remaining = new Set([...current].filter((id) => currentIds.has(id)));
      return remaining.size === current.size ? current : remaining;
    });
  }, [outlook.items]);

  // Opening Today is a refresh too: the sources load on their own, and the
  // cluster gets a job, unless one is already running for Today to follow, or
  // the boards are busy with an Assistant job.
  const followed = useRef(false);
  useEffect(() => {
    if (followed.current || !cluster || !active) return;
    followed.current = true;
    const running = refreshes(cluster.jobs).find((candidate) => candidate.doneAt === null);
    if (running) setJobId(running.id);
    else if (!cluster.jobs.some((candidate) => candidate.plan && candidate.doneAt === null)) startJob();
  }, [cluster, active, startJob]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errors = (Object.keys(titles) as SourceName[]).flatMap((name) => signInError(titles[name], params.get(name) ?? "") ?? []);
    if ((Object.keys(titles) as SourceName[]).some((name) => params.has(name))) window.history.replaceState({}, "", window.location.pathname);
    setSignInErrors(errors);
  }, []);

  // Refresh again after five minutes, but only while someone is looking, and on coming back to Today.
  useEffect(() => {
    if (!active) return;
    function refreshIfDue() {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt.current >= 5 * 60_000) refresh();
    }
    refreshIfDue();
    const timer = setInterval(refreshIfDue, 30_000);
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if (event.key === "r" && !typing && !event.metaKey && !event.ctrlKey) refresh();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, refresh]);

  const items = sample || loading ? null : open;
  const waiting = items?.filter(isWaiting).length ?? 0;
  const connected = sources.filter((source) => source.status === "ready").length;
  const last = cluster ? refreshes(cluster.jobs).filter((entry) => entry.doneAt !== null).at(-1) : undefined;
  const now = Date.now() + offset;

  return (
    <div className="page" hidden={!active}>
      <header className="page-head">
        <div className="page-title">
          <h1>Today</h1>
          <p className="lede">Your Slack, Jira, GitHub and Outlook work, ranked by what needs you first.</p>
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
        <Stat label="Open tasks" value={items ? String(items.length) : "—"} note={items ? "From Slack, Jira, GitHub and Outlook" : "No source connected yet"} />
        <Stat label="Waiting on you" value={items ? String(waiting) : "—"} note={items ? "Direct messages, pull requests and unread email" : "No source connected yet"} tone={waiting ? "is-ember" : ""} />
        <Stat label="Sources connected" value={`${connected} / ${sources.length}`} note={connected === sources.length ? "All four sources connected" : "Connect the rest on Connections"} />
        <Stat
          label="Last refresh"
          value={last ? `${((last.doneAt! - last.queuedAt) / 1000).toFixed(1)} s` : "—"}
          note={failed ? "Cluster not reachable" : jobRunning ? `Refreshing now, ${Math.round(jobProgress * 100)}% done` : last ? `On ${last.nodes} ${last.nodes === 1 ? "board" : "boards"}, ${ago(now - last.doneAt!)}` : "None finished yet"}
        />
      </ul>

      <div className="page-body">
        <TasksPanel items={open} cleared={cleared} loading={loading} sample={sample} checked={checked} onDone={markDone} onUndo={undo} onSaved={jira.reload} onOutlookAction={deleteOutlook} onOutlookReply={replyToOutlook} />
      </div>
    </div>
  );
}
