import { useEffect, useState } from "react";
import { apiPath } from "../../lib/urls";
import "./Console.css";

const nodes = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];

type Worker = { id: string; lastSeen: string; current: string | null; takenFrom?: string | null; done: number };
type Task = { status: "queued" | "claimed" | "done" };
type ClusterState = { workers: Worker[]; tasks: Task[] };

// An idle worker asks the queue for work every half second and a busy one
// sends a heartbeat every second, so one that has been quiet this long has
// stopped. The queue hands its task to another worker after 2 seconds.
const STALE_MS = 3000;

function isLive(worker: Worker) {
  return Date.now() - new Date(worker.lastSeen).getTime() < STALE_MS;
}

export function ConsolePage() {
  const [cluster, setCluster] = useState<ClusterState | null>(null);

  useEffect(() => {
    async function load() {
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
    }
    void load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="console-page">
      <div className="console-summary" aria-label="Cluster task totals">
        {cluster ? (["queued", "claimed", "done"] as const).map((status) => (
          <span key={status}>{status} <strong>{cluster.tasks.filter((task) => task.status === status).length}</strong></span>
        )) : <span role="status">Cluster unavailable</span>}
      </div>
      <div className="node-grid" aria-label="Six node console">
        {nodes.map((node) => {
          const seen = cluster?.workers.find((candidate) => candidate.id === node);
          const worker = seen && isLive(seen) ? seen : undefined;
          return (
            <article className="node-card" key={node}>
              <header className="node-card-header">
                <span className="node-mark" />
                <h1>{node}</h1>
                <span className="node-role">NODE</span>
              </header>
              {worker ? (
                <div className="node-status">
                  <strong>{worker.current ? `Working on ${worker.current}` : "Idle"}</strong>
                  {worker.takenFrom && <span className="node-takeover">Took over from {worker.takenFrom}</span>}
                  <span>{worker.done} done</span>
                </div>
              ) : seen ? (
                <div className="node-status node-lost">
                  <strong>No heartbeat</strong>
                  <span>Worker stopped responding</span>
                </div>
              ) : (
                <div className="node-empty">Waiting for node connection</div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
