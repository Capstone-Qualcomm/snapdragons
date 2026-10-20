import { useState } from "react";
import { send, useCluster } from "./cluster";
import { Nodes } from "./Nodes";
import { LatestRefresh, RefreshTimes } from "./Refresh";
import "./console-compat.css";
import "./Console.css";

export function ConsolePage() {
  const { cluster, failed, reload, serverNow } = useCluster();
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body?: unknown) {
    setError(await send(path, body));
    void reload();
  }

  const up = cluster?.nodes.filter((node) => node.up).length ?? 0;

  return (
    <div className="console">
      <header className="page-head">
        <h1>Console</h1>
        <div className="page-actions">
          <label className="switch">
            <input type="checkbox" checked={cluster?.auto ?? false} disabled={!cluster} onChange={(event) => void act("/api/cluster/auto", { on: event.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
            Auto refresh
          </label>
          <button className="button primary" type="button" disabled={!cluster?.orchestrator} onClick={() => void act("/api/cluster/refresh")}>
            Run refresh
          </button>
          <button className="button" type="button" disabled={!cluster || cluster.nodes.length >= cluster.maxNodes} onClick={() => void act("/api/cluster/nodes")}>
            Add node
          </button>
          <button className="button" type="button" disabled={!up} onClick={() => void act("/api/cluster/restart")}>
            Restart all nodes
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
          <Nodes cluster={cluster} serverNow={serverNow} act={(path, body) => void act(path, body)} />
          <div className="console-lower">
            <LatestRefresh cluster={cluster} now={serverNow()} />
            <RefreshTimes jobs={cluster.jobs} members={cluster.members.length} />
          </div>
        </>
      )}
    </div>
  );
}
