import { useCallback, useEffect, useState } from "react";
import { apiPath } from "../../lib/urls";
import "./Console.css";

type Worker = { id: string; lastSeen: string; current: string | null; takenFrom?: string | null; done: number };
type Job = { id: string; name: string };
type Task = { id: string; input: string; status: "queued" | "claimed" | "done"; worker: string | null; lostBy: string[]; job: Job | null };
type ClusterEvent = { at: string; text: string };
type ClusterState = { workers: Worker[]; tasks: Task[]; events?: ClusterEvent[]; maxNodes?: number };

// The product's morning refresh: the four fetches run on different nodes at
// the same time, and ranking waits for all of them.
const morningRefresh = { name: "Morning refresh", steps: ["Fetch Jira", "Fetch Slack", "Fetch GitHub", "Fetch Outlook"], then: "Rank" };

// The server's node cap, used for the empty slots before it first answers.
const DEFAULT_MAX_NODES = 6;
const JOBS_SHOWN = 4;

// An idle worker asks the queue for work every half second and a busy one
// sends a heartbeat every second, so one that has been quiet this long has
// stopped. The queue hands its task to another worker after 2 seconds.
const STALE_MS = 3000;

function isLive(worker: Worker) {
  return Date.now() - new Date(worker.lastSeen).getTime() < STALE_MS;
}

// Jobs are numbered J-1, J-2, ..., so the number picks one of four colors.
function jobColor(job: Job) {
  return `job-color-${Number(job.id.slice(2)) % 4}`;
}

export function ConsolePage() {
  const [cluster, setCluster] = useState<ClusterState | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiPath("/api/cluster/state"), { cache: "no-store" });
      const state = await response.json();
      if (
        !response.ok ||
        !Array.isArray(state?.workers) ||
        !Array.isArray(state?.tasks) ||
        !state.tasks.every((task: Task | null) => task && ["queued", "claimed", "done"].includes(task.status)) ||
        !state.workers.every((worker: Worker | null) => worker && typeof worker.id === "string" && typeof worker.lastSeen === "string" && (worker.current === null || typeof worker.current === "string") && (worker.takenFrom == null || typeof worker.takenFrom === "string") && typeof worker.done === "number")
      ) throw new Error("Cluster unavailable");
      setCluster(state);
    } catch {
      setCluster(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [load]);

  async function post(path: string, body: unknown = {}) {
    try {
      const response = await fetch(apiPath(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      setNotice(response.ok ? "" : data?.error ?? `Request failed (${response.status})`);
    } catch {
      setNotice("Cluster unavailable");
    }
    void load();
  }

  const workers = [...(cluster?.workers ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const maxNodes = cluster?.maxNodes ?? DEFAULT_MAX_NODES;
  const tasks = cluster?.tasks ?? [];

  return (
    <div className="console-page">
      <div className="console-toolbar">
        <div className="console-summary" aria-label="Cluster task totals">
          {cluster ? (["queued", "claimed", "done"] as const).map((status) => (
            <span key={status}>{status} <strong>{tasks.filter((task) => task.status === status).length}</strong></span>
          )) : <span role="status">Cluster unavailable</span>}
        </div>
        {notice && <span className="console-notice" role="alert">{notice}</span>}
        <div className="console-actions">
          <button type="button" disabled={!cluster} onClick={() => void post("/api/cluster/jobs", morningRefresh)}>Run morning refresh</button>
          <button type="button" disabled={!cluster || workers.length >= maxNodes} onClick={() => void post("/api/cluster/nodes")}>Add node</button>
        </div>
      </div>
      <div className="node-grid" aria-label="Cluster nodes">
        {workers.map((worker) => (
          <NodeCard
            key={worker.id}
            worker={worker}
            task={tasks.find((task) => task.id === worker.current)}
            onKill={() => void post(`/api/cluster/nodes/${worker.id}/kill`)}
            onRestart={() => void post(`/api/cluster/nodes/${worker.id}/start`)}
          />
        ))}
        {Array.from({ length: Math.max(0, maxNodes - workers.length) }, (_, slot) => (
          <article className="node-card" key={`slot-${slot}`}>
            <div className="node-empty">Waiting for node connection</div>
          </article>
        ))}
      </div>
      <div className="console-lower">
        <JobList tasks={tasks} />
        <Timeline events={cluster?.events ?? []} />
      </div>
    </div>
  );
}

function NodeCard({ worker, task, onKill, onRestart }: { worker: Worker; task?: Task; onKill: () => void; onRestart: () => void }) {
  const live = isLive(worker);
  const state = !live ? "dead" : worker.current ? "working" : "idle";
  return (
    <article className={`node-card node-${state}`}>
      <header className="node-card-header">
        <span className="node-mark" />
        <h1>{worker.id}</h1>
        <span className="node-role">{state.toUpperCase()}</span>
      </header>
      {live ? (
        <div className="node-status">
          <strong>{worker.current ? `Working on ${worker.current}` : "Idle"}</strong>
          {task && <span className={task.job ? `node-step ${jobColor(task.job)}` : "node-step"}>{task.input}</span>}
          {worker.takenFrom && <span className="node-takeover">Took over from {worker.takenFrom}</span>}
          <span>{worker.done} done</span>
        </div>
      ) : (
        <div className="node-status node-lost">
          <strong>No heartbeat</strong>
          <span>Worker stopped responding</span>
          <span>{worker.done} done</span>
        </div>
      )}
      <footer className="node-card-footer">
        {live ? <button type="button" className="node-kill" onClick={onKill}>Kill</button> : <button type="button" onClick={onRestart}>Restart</button>}
      </footer>
    </article>
  );
}

// The newest jobs, one row per step: where it ran, and which node lost it if one died mid-step.
function JobList({ tasks }: { tasks: Task[] }) {
  const jobs = [...new Map(tasks.filter((task) => task.job).map((task) => [task.job!.id, task.job!])).values()].reverse().slice(0, JOBS_SHOWN);
  return (
    <section className="console-panel" aria-label="Jobs">
      <h2>Jobs</h2>
      {!jobs.length && <p className="console-empty">No jobs yet</p>}
      {jobs.map((job) => {
        const steps = tasks.filter((task) => task.job?.id === job.id);
        return (
          <div className={`job ${jobColor(job)}`} key={job.id}>
            <p className="job-title">
              <b>{job.id} {job.name}</b>
              <span>{steps.filter((step) => step.status === "done").length}/{steps.length} done</span>
            </p>
            {steps.map((step) => <StepRow key={step.id} step={step} />)}
          </div>
        );
      })}
    </section>
  );
}

function StepRow({ step }: { step: Task }) {
  const where = step.status === "queued" ? "waiting" : step.status === "claimed" ? `running on ${step.worker}` : `done by ${step.worker}`;
  return (
    <p className={`step step-${step.status}`}>
      <span className="step-id">{step.id}</span>
      <span className="step-name">{step.input}</span>
      {step.lostBy.length > 0 && <span className="step-lost">lost by {step.lostBy.join(", ")}</span>}
      <span className="step-where">{where}</span>
    </p>
  );
}

function Timeline({ events }: { events: ClusterEvent[] }) {
  return (
    <section className="console-panel" aria-label="Events">
      <h2>Events</h2>
      {!events.length && <p className="console-empty">Nothing yet</p>}
      <ol className="timeline">
        {events.map((event) => (
          <li key={`${event.at} ${event.text}`}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time>
            <span>{event.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
