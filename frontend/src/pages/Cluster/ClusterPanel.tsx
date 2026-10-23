import { BoardsTable } from "./Boards";
import type { ClusterState } from "./cluster";
import "./Cluster.css";

// The boards and the controls for the demo: add one, restart them all, or kill
// one from its row and watch its step move to another board.
export function ClusterPanel({ cluster, failed, error, act }: { cluster: ClusterState | null; failed: boolean; error: string | null; act: (path: string, body?: unknown) => void }) {
  const nodes = cluster?.nodes ?? [];
  const up = nodes.filter((node) => node.up).length;
  // With too few members up, no board can win an election, so the cluster waits.
  const members = cluster?.members.length ?? 0;
  const membersUp = nodes.filter((node) => node.up && node.member).length;
  const needed = Math.floor(members / 2) + 1;
  const stuck = cluster && !cluster.orchestrator && members > 0 && membersUp < needed;

  return (
    <section className="panel" id="cluster" aria-labelledby="cluster-title">
      <header className="panel-head">
        <h2 id="cluster-title">Boards</h2>
        {cluster && <span className="panel-meta"><b className="num">{up} of {nodes.length}</b> boards online</span>}
        <div className="panel-actions">
          <label className="switch">
            <input type="checkbox" checked={cluster?.auto ?? false} disabled={!cluster} onChange={(event) => act("/api/cluster/auto", { on: event.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
            Auto refresh
          </label>
          <button className="button small" type="button" disabled={!cluster || nodes.length >= cluster.maxNodes} onClick={() => act("/api/cluster/nodes")}>
            Add board
          </button>
          <button className="button small" type="button" disabled={!up} onClick={() => act("/api/cluster/restart")}>
            Restart all
          </button>
          <button className="button small primary" type="button" disabled={!cluster?.orchestrator} onClick={() => act("/api/cluster/refresh")}>
            Run refresh
          </button>
        </div>
      </header>
      {(error || failed) && (
        <div className="error-banner" role="alert">
          <p>{error ?? (cluster ? "The cluster is not reachable. Showing the last received state." : "The cluster is not reachable.")}</p>
        </div>
      )}
      {stuck && (
        <p className="notice" role="status">
          No orchestrator: {membersUp} of {members} boards are up, and an election needs {needed}. Restart a board to carry on.
        </p>
      )}
      {cluster && <BoardsTable cluster={cluster} act={act} />}
    </section>
  );
}
