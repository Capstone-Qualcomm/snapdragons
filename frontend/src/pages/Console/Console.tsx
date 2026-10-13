import { useEffect, useState } from "react";
import "./Console.css";

const nodes = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];

type Worker = { id: string; lastSeen: string; current: string | null; done: number };

// An idle worker asks the queue for work every half second, so one that has
// been quiet this long has stopped. A worker holding a task does not poll.
const STALE_MS = 5000;

function isLive(worker: Worker) {
  return worker.current !== null || Date.now() - new Date(worker.lastSeen).getTime() < STALE_MS;
}

export function ConsolePage() {
  const [workers, setWorkers] = useState<Worker[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/api/cluster/state", { cache: "no-store" });
        const state = await response.json();
        setWorkers(Array.isArray(state?.workers) ? state.workers : []);
      } catch {
        // The cluster is not running, so every card goes back to waiting.
        setWorkers([]);
      }
    }
    void load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="node-grid" aria-label="Six node console">
      {nodes.map((node) => {
        const worker = workers.find((candidate) => candidate.id === node && isLive(candidate));
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
                <span>{worker.done} done</span>
              </div>
            ) : (
              <div className="node-empty">Waiting for node connection</div>
            )}
          </article>
        );
      })}
    </div>
  );
}
