import { BoardsTable } from "./Boards";
import type { ClusterState } from "./cluster";
import "./Cluster.css";

// The boards and what each is doing. The commands that act on them are in Agent Commands above.
export function ClusterPanel({ cluster, failed }: { cluster: ClusterState | null; failed: boolean }) {
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
      </header>
      {failed && (
        <div className="error-banner" role="alert">
          <p>{cluster ? "The cluster is not reachable. Showing the last received state." : "The cluster is not reachable."}</p>
        </div>
      )}
      {stuck && (
        <p className="notice" role="status">
          No orchestrator: {membersUp} of {members} boards are up, and an election needs {needed}. Restart a board to carry on.
        </p>
      )}
      {cluster && <BoardsTable cluster={cluster} />}
    </section>
  );
}
