import { Fragment, useState } from "react";
import type { CSSProperties } from "react";
import { appPath } from "../../lib/urls";
import "./Boards.css";
import { boardName, seconds, sourceOf, stepLabel } from "./cluster";
import type { ClusterState, RaftNode, Task } from "./cluster";

type BoardState = "dead" | "left" | "joining" | "leaving" | "working" | "idle";

// What one board is doing right now, from the gateway's state.
export function boardOf(node: RaftNode, cluster: ClusterState) {
  const worker = cluster.workers.find((candidate) => candidate.id === node.id);
  const task = cluster.tasks.find((candidate) => candidate.status === "claimed" && candidate.worker === node.id);
  const state: BoardState = !node.up ? (node.member ? "dead" : "left") : !node.member ? "joining" : worker?.leaving ? "leaving" : task ? "working" : "idle";
  return { task, state, worker, isOrchestrator: node.id === cluster.orchestrator };
}

const status: Record<BoardState, { label: string; tone: string }> = {
  dead: { label: "Down", tone: "is-bad" },
  left: { label: "Removed", tone: "" },
  joining: { label: "Joining", tone: "is-warn" },
  leaving: { label: "Leaving", tone: "is-warn" },
  working: { label: "Online", tone: "is-ok" },
  idle: { label: "Online", tone: "is-ok" },
};

// One row per board: whether it is up, its role, what it is doing and how much
// it has done. Its Raft numbers open under it on a click. Commands for a board
// are in Agent Commands.
export function BoardsTable({ cluster }: { cluster: ClusterState }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <table className="table boards-table" aria-label="Boards">
      <thead>
        <tr>
          <th>Board</th>
          <th>Status</th>
          <th>Role</th>
          <th>Current task</th>
          <th className="num">Tasks done</th>
          <th className="num">Last heartbeat</th>
        </tr>
      </thead>
      <tbody>
        {cluster.nodes.map((node) => (
          <Fragment key={node.id}>
            <BoardRow node={node} cluster={cluster} open={open === node.id} onToggle={() => setOpen(open === node.id ? null : node.id)} />
            {open === node.id && (
              <tr className="detail-row">
                <td colSpan={6}>
                  <span className="raft">
                    <span>Network id {node.id}</span>
                    {node.up && (
                      <>
                        <span>term {node.term}</span>
                        <span>log {node.lastIndex}</span>
                        <span>commit {node.commitIndex}</span>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function BoardRow({ node, cluster, open, onToggle }: { node: RaftNode; cluster: ClusterState; open: boolean; onToggle: () => void }) {
  const { task, state, worker, isOrchestrator } = boardOf(node, cluster);
  const needed = Math.floor((node.members?.length ?? 0) / 2) + 1;
  // While there is no orchestrator, each worker counts down its own random
  // timeout; the first to reach zero asks the others for their votes.
  const electing = node.up && node.member && !cluster.orchestrator;
  const role = !node.up || !node.member ? "—" : node.role === "candidate" ? `Candidate, ${node.votes?.length ?? 0} of ${needed} votes` : isOrchestrator ? "Orchestrator" : electing ? `Worker, election in ${((node.electionIn ?? 0) / 1000).toFixed(1)} s` : "Worker";

  return (
    <tr className={`board-row is-${state}${isOrchestrator ? " is-orchestrator" : ""}`} aria-label={boardName(node.id)}>
      <td className="col-board">
        <button className="board-toggle" type="button" aria-expanded={open} onClick={onToggle} title="Show Raft details">
          <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d={open ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} /></svg>
          {boardName(node.id)}
        </button>
      </td>
      <td className="col-status">
        <span className={`badge ${status[state].tone}`}>
          <i className="badge-dot" aria-hidden="true" />
          {status[state].label}
        </span>
      </td>
      <td className={`col-role${isOrchestrator ? " is-orchestrator" : ""}`}>
        {isOrchestrator && <Crown />}
        {role}
      </td>
      <td className="col-task">
        <Work task={task} node={node} />
      </td>
      <td className="col-done-count num">{worker?.done ?? 0}</td>
      <td className="col-heartbeat num">{heartbeat(node, isOrchestrator)}</td>
    </tr>
  );
}

// Workers hear the orchestrator's heartbeat every 300 ms; the orchestrator sends it.
function heartbeat(node: RaftNode, isOrchestrator: boolean) {
  if (!node.up) return "—";
  if (isOrchestrator) return "Sending";
  if (node.quietFor == null) return "—";
  return node.quietFor < 1000 ? `${node.quietFor} ms ago` : `${seconds(node.quietFor)} ago`;
}

// The step a board is on, in words, with its progress. A step taken over from
// a dead board says so, and its bar starts where that board's checkpoint was.
function Work({ task, node }: { task?: Task; node: RaftNode }) {
  if (!node.up) return <span className="muted">—</span>;
  if (!task) return <span className="muted">Idle</span>;
  const run = task.runs.at(-1)!;
  const from = task.lostBy.at(-1);
  return (
    <span className="step-progress" title={task.input}>
      <span className="step-title">
        <SourceIcon step={task.input} />
        <span className="step-name">{stepLabel(task.input)}</span>
        <span className="step-meta num">{Math.round(task.progress * 100)}%</span>
      </span>
      <span className="bar" style={{ "--from": run.from, "--to": task.progress } as CSSProperties}>
        <i className="bar-before" />
        <i className="bar-now" />
      </span>
      {from && <span className="took-over">Taken over from {boardName(from)}</span>}
    </span>
  );
}

export function SourceIcon({ step }: { step: string }) {
  const source = sourceOf(step);
  return source ? <img className={`logo logo-${source}`} src={appPath(`${source}-logo.png`)} alt="" /> : (
    <svg className="logo logo-rank" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h7.5M2.5 12h4" />
    </svg>
  );
}

// Drawn beside the word "Orchestrator", so it says nothing more to a screen reader.
function Crown() {
  return (
    <svg className="crown" viewBox="0 0 16 12" aria-hidden="true">
      <path d="M1 10.5h14L13.6 3 10.4 6.4 8 1.5 5.6 6.4 2.4 3z" />
    </svg>
  );
}
