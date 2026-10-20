import { useState } from "react";
import { Activity } from "./Activity";
import { QueueChips, Rack } from "./Boards";
import { send, useCluster } from "./cluster";
import { LatestRefresh, RefreshTimes } from "./Refresh";
import { Timeline } from "./Timeline";
import "./Cluster.css";

export function ClusterPage() {
  const { cluster, failed, reload, serverNow } = useCluster();
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body?: unknown) {
    setError(await send(path, body));
    void reload();
  }

  const up = cluster?.nodes.filter((node) => node.up).length ?? 0;

  return (
    <div className="cluster">
      <header className="page-head cluster-head">
        <div className="queue" aria-label="Queue" role="group">
          <span className="queue-name">Queue</span>
          {cluster && <QueueChips cluster={cluster} />}
        </div>
        <div className="page-actions">
          <label className="switch">
            <input type="checkbox" checked={cluster?.auto ?? false} disabled={!cluster} onChange={(event) => void act("/api/cluster/auto", { on: event.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
            Auto refresh
          </label>
          <button className="button" type="button" disabled={!up} onClick={() => void act("/api/cluster/restart")}>
            Restart all nodes
          </button>
          <button className="button primary" type="button" disabled={!cluster?.orchestrator} onClick={() => void act("/api/cluster/refresh")}>
            Refresh
          </button>
        </div>
      </header>
      {(error || failed) && (
        <div className="error-banner" role="alert">
          <p>{error ?? (cluster ? "The cluster is not reachable. Showing the last received state." : "The cluster is not reachable.")}</p>
        </div>
      )}
      {cluster && (
        <>
          <Rack cluster={cluster} act={(path, body) => void act(path, body)} />
          <Timeline cluster={cluster} serverNow={serverNow} />
          <div className="cluster-lower">
            <LatestRefresh cluster={cluster} now={serverNow()} />
            <RefreshTimes jobs={cluster.jobs} members={cluster.members.length} maxNodes={cluster.maxNodes} />
            <Activity events={cluster.events} offset={serverNow() - Date.now()} />
          </div>
        </>
      )}
    </div>
  );
}
