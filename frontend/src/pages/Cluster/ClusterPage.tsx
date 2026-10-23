import { useState } from "react";
import { ago, Stat } from "../../components/ui";
import { Activity } from "./Activity";
import { boardName, refreshes, send } from "./cluster";
import type { ClusterState } from "./cluster";
import { ClusterPanel } from "./ClusterPanel";
import { RefreshChart } from "./Refresh";
import { Timeline } from "./Timeline";

// The boards: who is up, who is orchestrator, what each is doing, how long refreshes take, and what happened.
export function ClusterPage({ cluster, failed, reload, serverNow }: { cluster: ClusterState | null; failed: boolean; reload: () => Promise<void>; serverNow: () => number }) {
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body?: unknown) {
    setError(await send(path, body));
    void reload();
  }

  const offset = serverNow() - Date.now();
  const now = Date.now() + offset;
  const nodes = cluster?.nodes ?? [];
  const up = nodes.filter((node) => node.up).length;
  const done = cluster ? refreshes(cluster.jobs).filter((job) => job.doneAt !== null) : [];
  const last = done.at(-1);
  const term = cluster?.terms.at(-1);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Cluster</h1>
          <p className="lede">The Arduino Uno Q boards doing the work. One leads as orchestrator; if it dies, the rest elect another.</p>
        </div>
      </header>

      <ul className="stats is-4" aria-label="Summary">
        <Stat label="Boards online" value={cluster ? `${up} / ${nodes.length}` : "—"} note={!cluster ? "Cluster not reachable" : up === nodes.length ? "All boards up" : `${nodes.length - up} down`} tone={cluster && up < nodes.length ? "is-bad" : ""} />
        <Stat
          label="Orchestrator"
          value={cluster?.orchestrator ? boardName(cluster.orchestrator) : cluster ? "None" : "—"}
          note={cluster?.orchestrator ? (term ? `Elected ${ago(now - term.at)}` : "Hands out the steps") : cluster ? "Boards are electing one" : "Cluster not reachable"}
          tone={cluster && !cluster.orchestrator ? "is-warn" : ""}
        />
        <Stat label="Last refresh" value={last ? `${((last.doneAt! - last.queuedAt) / 1000).toFixed(1)} s` : "—"} note={last ? `On ${last.nodes} ${last.nodes === 1 ? "board" : "boards"}, ${ago(now - last.doneAt!)}` : "None finished yet"} />
        <Stat label="Steps done" value={cluster ? String(cluster.workers.reduce((sum, worker) => sum + worker.done, 0)) : "—"} note="By every board since it joined" />
      </ul>

      <div className="page-body">
        <ClusterPanel cluster={cluster} failed={failed} error={error} act={(path, body) => void act(path, body)} />
        {cluster && <Timeline cluster={cluster} serverNow={serverNow} />}
        {cluster && (
          <div className="pair">
            <RefreshChart jobs={refreshes(cluster.jobs)} offset={offset} />
            <Activity events={cluster.events} tasks={cluster.tasks} offset={offset} />
          </div>
        )}
      </div>
    </div>
  );
}
