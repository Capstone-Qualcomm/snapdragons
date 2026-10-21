import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { ErrorBanner, RelativeTime, SkeletonRows, SourceLogo } from "../../components/ui";
import { api } from "../../lib/api";
import { appPath } from "../../lib/urls";
import { BoardStrip } from "../Cluster/Boards";
import { useCluster } from "../Cluster/cluster";
import { Connection, signInError } from "./Connections";
import { JiraEditor } from "./JiraEditor";
import { rank, toItems } from "./rank";
import type { Item } from "./rank";
import { titles, useSource } from "./sources";
import type { Source, SourceName } from "./sources";
import "./Today.css";

const DONE_KEY = "continuum-done";

// What was marked done, kept in this browser. An item counts as done only
// until it changes again, so a new reply brings it back.
function useDone() {
  const [done, setDone] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : [];
    } catch {
      return [];
    }
  });
  const update = (next: string[]) => {
    // ponytail: keeps the newest 300; old items that no longer come back are not worth more
    const kept = next.slice(-300);
    setDone(kept);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(kept));
    } catch {
      // Done still works for this visit.
    }
  };
  const id = (item: Item) => `${item.key}@${item.at}`;
  return {
    isDone: (item: Item) => done.includes(id(item)),
    markDone: (item: Item) => update([...done, id(item)]),
    undo: (item: Item) => update(done.filter((key) => key !== id(item))),
  };
}

export function TodayPage({ active = true, onOpenCluster }: { active?: boolean; onOpenCluster?: () => void }) {
  const slack = useSource("slack");
  const jira = useSource("jira");
  const github = useSource("github");
  const { cluster, failed } = useCluster();
  const { isDone, markDone, undo } = useDone();
  const [jobId, setJobId] = useState<string | null>(null);
  const [signInErrors, setSignInErrors] = useState<string[]>([]);
  const lastRefreshAt = useRef(Date.now());
  const sources = [slack, jira, github];

  const ranked = rank(toItems({ slack: slack.items, jira: jira.items, github: github.items }));
  const open = ranked.filter((item) => !isDone(item));
  const cleared = ranked.filter(isDone);
  const counts = Object.fromEntries((Object.keys(titles) as SourceName[]).map((name) => [name, open.filter((item) => item.source === name).length]));
  // A visitor with no source connected sees what Today is for, not a blank page.
  const loading = sources.every((source) => source.status === "loading");
  const ready = sources.some((source) => source.status === "ready");

  // The refresh this page asked the cluster for, and how far along it is.
  const job = cluster?.jobs.find((candidate) => candidate.id === jobId);
  const steps = cluster?.tasks.filter((task) => task.job === jobId) ?? [];
  const jobProgress = steps.length ? steps.reduce((sum, task) => sum + task.progress, 0) / steps.length : 0;
  const jobRunning = Boolean(job && job.doneAt === null && cluster?.orchestrator);
  const syncing = sources.some((source) => source.syncing);
  const busy = syncing || jobRunning;

  const startJob = useCallback(() => {
    api<{ job: { id: string } }>("/api/cluster/refresh", {}).then(({ job }) => setJobId(job.id), () => {});
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
  // cluster gets a job, unless one is already running for Today to follow.
  const followed = useRef(false);
  useEffect(() => {
    if (followed.current || !cluster) return;
    followed.current = true;
    const running = cluster.jobs.find((candidate) => candidate.doneAt === null);
    if (running) setJobId(running.id);
    else startJob();
  }, [cluster, startJob]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errors = (Object.keys(titles) as SourceName[]).flatMap((name) => signInError(titles[name], params.get(name) ?? "") ?? []);
    if ((Object.keys(titles) as SourceName[]).some((name) => params.has(name))) window.history.replaceState({}, "", window.location.pathname);
    setSignInErrors(errors);
  }, []);

  // Refresh again after five minutes, but only while someone is looking.
  useEffect(() => {
    if (!active) return;
    function refreshIfDue() {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt.current >= 5 * 60_000) refresh();
    }
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

  function openCluster(event: MouseEvent) {
    if (!onOpenCluster || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    onOpenCluster();
  }

  return (
    <div className="today">
      <header className="today-head">
        <div className="sources">
          {sources.map((source) => <Connection key={source.name} source={source} count={counts[source.name]} />)}
        </div>
        <div className="today-refresh">
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
        </div>
      </header>

      <a className="strip" href={appPath("cluster")} onClick={openCluster} aria-label="Cluster">
        {cluster ? (
          <BoardStrip cluster={cluster} />
        ) : failed ? (
          <span className="strip-error">The cluster is not reachable.</span>
        ) : null}
      </a>

      {signInErrors.map((message) => <ErrorBanner key={message} message={message} />)}
      {sources.map((source) => source.status === "error" && <ErrorBanner key={source.name} message={source.error} onRetry={() => void source.reload()} />)}

      {loading ? (
        <SkeletonRows count={5} />
      ) : open.length > 0 ? (
        <ol className="today-list" aria-label="Today">
          {open.map((item) => (
            <Row key={item.key} item={item} onDone={() => markDone(item)} onSaved={jira.reload} />
          ))}
        </ol>
      ) : ready ? (
        <p className="today-empty">Nothing waiting. You are all caught up.</p>
      ) : (
        <SampleDashboard sources={sources} />
      )}

      {cleared.length > 0 && (
        <details className="done-list">
          <summary>
            Done <span className="count">{cleared.length}</span>
          </summary>
          <ol className="today-list">
            {cleared.map((item) => (
              <li className="today-row is-done" key={item.key}>
                <SourceLogo name={item.source} />
                <Who item={item} />
                <p className="what">{textOf(item)}</p>
                <button className="button small quiet" type="button" onClick={() => undo(item)}>Undo</button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function textOf(item: Item) {
  return item.source === "slack" ? item.data.text : item.source === "jira" ? item.data.summary : item.data.title;
}

// A visitor with nothing connected sees a worked example: the same rows Today
// builds, filled with sample items, and the buttons that connect each source.
function SampleDashboard({ sources }: { sources: Source<unknown>[] }) {
  return (
    <section className="sample" aria-labelledby="sample-title">
      <div className="sample-head">
        <h2 id="sample-title"><span className="sample-chip">Sample</span> What Today looks like with a source connected</h2>
        <p>Connect Jira, Slack and GitHub and this list fills with your tickets, mentions and pull requests, ranked by what is most urgent.</p>
      </div>
      <ol className="today-list sample-list" aria-label="Sample items">
        {rank(sampleItems()).map((item) => <SampleRow key={item.key} item={item} />)}
      </ol>
      <div className="sources sample-connect">
        <span className="sample-connect-label">Connect a source to get started</span>
        {sources.map((source) => <Connection key={source.name} source={source} count={0} />)}
      </div>
    </section>
  );
}

const sampleAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// Illustrative only: these are never written anywhere.
function sampleItems(): Item[] {
  const at = (minutes: number) => Date.now() - minutes * 60_000;
  return [
    {
      key: "sample:slack", source: "slack", at: at(3),
      data: { id: "sample-slack", kind: "dm", from: "Priya Raman", where: "Direct message", text: "Can you look over the demo script before standup?", sentAt: sampleAgo(3), url: "" },
    },
    {
      key: "sample:jira", source: "jira", at: at(41),
      data: { key: "QT1S-42", summary: "Wire the failover test into CI", status: "In Progress", issueType: "Task", updated: sampleAgo(41), url: "", description: "", sprints: ["Sprint 5"], labels: [], storyPointEstimate: 3, reporter: "You" },
    },
    {
      key: "sample:github", source: "github", at: at(95),
      data: { id: "sample-github", kind: "pull_request", repository: "Capstone-Qualcomm/snapdragons", number: 15, title: "Today and Cluster redesign", state: "open", updatedAt: sampleAgo(95), url: "" },
    },
  ];
}

function SampleRow({ item }: { item: Item }) {
  return (
    <li className={`today-row is-sample is-${item.source}`}>
      <span className="done-button is-sample" aria-hidden="true" />
      <SourceLogo name={item.source} />
      <SampleWho item={item} />
      <p className="what">{item.source === "slack" ? withMentions(item.data.text) : textOf(item)}</p>
      <RelativeTime value={item.at} />
      <span className="row-action" />
    </li>
  );
}

// The same detail as Who, without the links a sample must not follow.
function SampleWho({ item }: { item: Item }) {
  switch (item.source) {
    case "slack":
      return (
        <div className="who">
          <strong>{item.data.from}</strong>
          <span>{item.data.kind === "dm" ? "DM" : item.data.where}</span>
        </div>
      );
    case "jira":
      return (
        <div className="who">
          <span className="jira-key">{item.data.key}</span>
          <span className={/progress|review/i.test(item.data.status) ? "status is-started" : "status"}>{item.data.status}</span>
        </div>
      );
    case "github":
      return (
        <div className="who">
          <strong title={item.data.repository}>{item.data.repository.split("/").at(-1)} #{item.data.number}</strong>
          <span>{item.data.kind === "pull_request" ? "Pull request" : "Issue"}</span>
        </div>
      );
  }
}

function Row({ item, onDone, onSaved }: { item: Item; onDone: () => void; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const editorId = `edit-${item.key}`;

  return (
    <li className={`today-row is-${item.source}`} aria-label={textOf(item)}>
      <button className="done-button" type="button" aria-label="Done" title="Done" onClick={onDone}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>
      </button>
      <SourceLogo name={item.source} />
      <Who item={item} />
      <p className="what">{item.source === "slack" ? withMentions(item.data.text) : textOf(item)}</p>
      {item.at > 0 ? <RelativeTime value={item.at} /> : <span />}
      <span className="row-action">
        {item.source === "slack" && <a className="button small" href={item.data.url} target="_blank" rel="noreferrer">Reply</a>}
        {item.source === "github" && <a className="button small" href={item.data.url} target="_blank" rel="noreferrer">Open</a>}
        {item.source === "jira" && (
          <button className={editing ? "button small is-on" : "button small"} type="button" aria-expanded={editing} aria-controls={editorId} onClick={() => setEditing(!editing)}>
            Edit
          </button>
        )}
      </span>
      {item.source === "jira" && editing && <JiraEditor issue={item.data} id={editorId} onSaved={onSaved} onClose={() => setEditing(false)} />}
    </li>
  );
}

// Who is asking, or which ticket or pull request it is, with the one detail that ranked it.
function Who({ item }: { item: Item }) {
  switch (item.source) {
    case "slack":
      return (
        <div className="who">
          <strong>{item.data.from}</strong>
          <span>{item.data.kind === "dm" ? "DM" : item.data.where}</span>
        </div>
      );
    case "jira":
      return (
        <div className="who">
          <a className="jira-key" href={item.data.url} target="_blank" rel="noreferrer">{item.data.key}</a>
          <span className={/progress|review/i.test(item.data.status) ? "status is-started" : "status"}>{item.data.status}</span>
        </div>
      );
    case "github":
      return (
        <div className="who">
          <strong title={item.data.repository}>{item.data.repository.split("/").at(-1)} #{item.data.number}</strong>
          <span>{item.data.kind === "pull_request" ? "Pull request" : "Issue"}</span>
        </div>
      );
  }
}

function withMentions(text: string) {
  return text.split(/(@you\b)/).map((part, index) => (part === "@you" ? <mark key={index}>@you</mark> : part));
}
