import type { CSSProperties } from "react";
import { appPath } from "../../lib/urls";
import "./Boards.css";
import { jobColor, shortName, sourceOf } from "./cluster";
import type { ClusterState, RaftNode, Task } from "./cluster";

type BoardState = "dead" | "left" | "joining" | "leaving" | "working" | "idle";

// What one board is doing right now, from the gateway's state.
function boardOf(node: RaftNode, cluster: ClusterState) {
  const worker = cluster.workers.find((candidate) => candidate.id === node.id);
  const task = cluster.tasks.find((candidate) => candidate.status === "claimed" && candidate.worker === node.id);
  const state: BoardState = !node.up ? (node.member ? "dead" : "left") : !node.member ? "joining" : worker?.leaving ? "leaving" : task ? "working" : "idle";
  return { task, state, leaving: Boolean(worker?.leaving), isOrchestrator: node.id === cluster.orchestrator };
}

const led: Record<BoardState, string> = { dead: "tone-bad", left: "tone-off", joining: "tone-warn", leaving: "tone-warn", working: "tone-busy", idle: "tone-ok" };

type Act = (path: string, body?: unknown) => void;

// The rack: one slot per Uno Q board, filled or empty. Each board shows its
// Raft role and the step it is running; an empty slot adds a node.
export function Rack({ cluster, act }: { cluster: ClusterState; act: Act }) {
  const empty = Math.max(cluster.maxNodes - cluster.nodes.length, 0);
  return (
    <ul className="rack" aria-label="Nodes">
      {cluster.nodes.map((node) => <Board key={node.id} node={node} cluster={cluster} act={act} />)}
      {Array.from({ length: empty }, (_, index) => (
        <li className="slot" key={index}>
          {index === 0 && (
            <button className="slot-add" type="button" onClick={() => act("/api/cluster/nodes")}>
              <span aria-hidden="true">+</span>Add node
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Board({ node, cluster, act }: { node: RaftNode; cluster: ClusterState; act: Act }) {
  const { task, state, leaving, isOrchestrator } = boardOf(node, cluster);
  const path = (action: string) => `/api/cluster/nodes/${node.id}/${action}`;
  const needed = Math.floor((node.members?.length ?? 0) / 2) + 1;
  const role = !node.up ? (state === "dead" ? "Dead" : "Left") : node.role === "candidate" ? "Candidate" : isOrchestrator ? "Orchestrator" : leaving ? "Leaving" : state === "joining" ? "Joining" : "Worker";
  // While there is no orchestrator, each worker counts down its own random
  // timeout; the first to reach zero asks the others for their votes.
  const electing = node.up && node.member && !cluster.orchestrator;

  return (
    <li className={`board is-${state}${isOrchestrator ? " is-orchestrator" : ""}`} role="group" aria-label={node.id}>
      <header className="board-head">
        <span className={`dot ${led[state]}`} aria-hidden="true" />
        <strong>{node.id}</strong>
        {isOrchestrator && <Crown />}
        <span className={`role is-${role.toLowerCase()}`}>{role}</span>
      </header>

      <div className="board-work">
        {task ? <StepProgress key={task.id} task={task} /> : <span className="board-idle" aria-hidden="true" />}
      </div>

      <div className="board-raft">
        {node.up && (
          <>
            <span>term {node.term}</span>
            <span>log {node.lastIndex}</span>
            <span>commit {node.commitIndex}</span>
          </>
        )}
      </div>
      {electing && node.role === "worker" && (
        <span className="countdown" aria-label={`election in ${((node.electionIn ?? 0) / 1000).toFixed(1)} s`}>
          <i style={{ width: `${Math.min((node.electionIn ?? 0) / 3000, 1) * 100}%` }} />
        </span>
      )}
      {node.role === "candidate" && node.up && (
        <span className="votes" aria-label={`${node.votes?.length ?? 0} of ${needed} votes`}>
          {Array.from({ length: needed }, (_, index) => <i key={index} className={index < (node.votes?.length ?? 0) ? "is-in" : ""} />)}
        </span>
      )}

      <div className="board-actions">
        {state === "dead" && <button className="button small" type="button" onClick={() => act(path("start"))}>Restart</button>}
        {(state === "dead" || (node.up && !leaving)) && <button className="button small" type="button" onClick={() => act(path("remove"))}>Remove</button>}
        {node.up && <button className="button small is-kill" type="button" onClick={() => act(path("kill"))}>Kill</button>}
      </div>
    </li>
  );
}

// The same boards in one line, for Today: who holds which step right now.
export function BoardStrip({ cluster }: { cluster: ClusterState }) {
  return (
    <ul className="strip-boards">
      {cluster.nodes.map((node) => {
        const { task, state, isOrchestrator } = boardOf(node, cluster);
        return (
          <li key={node.id} className={`mini is-${state}`} role="group" aria-label={node.id}>
            <span className={`dot ${led[state]}`} aria-hidden="true" />
            <strong>{node.id}</strong>
            {isOrchestrator && <Crown />}
            {task ? <StepProgress key={task.id} task={task} compact /> : <span className="board-idle" aria-hidden="true" />}
          </li>
        );
      })}
    </ul>
  );
}

// Steps waiting for a node. A step put back by a dead node keeps its checkpoint.
export function QueueChips({ cluster, compact }: { cluster: ClusterState; compact?: boolean }) {
  const done = new Set(cluster.tasks.filter((task) => task.status === "done").map((task) => task.id));
  return cluster.tasks.filter((task) => task.status === "queued").map((task) => (
    <span key={task.id} className={`step-chip ${jobColor(task.job)}${task.after.some((id) => !done.has(id)) ? " is-blocked" : ""}`} title={task.input}>
      <SourceIcon step={task.input} />
      {!compact && shortName(task.input)}
      {task.progress > 0 && <span className="chip-progress">{Math.round(task.progress * 100)}%</span>}
    </span>
  ));
}

// The bar starts where the step's last checkpoint was, so a step handed over
// from a dead node visibly carries on instead of starting again.
function StepProgress({ task, compact }: { task: Task; compact?: boolean }) {
  const run = task.runs.at(-1)!;
  const from = task.lostBy.at(-1);
  return (
    <div className={compact ? "step-progress is-compact" : "step-progress"} title={task.input}>
      <span className="step-title">
        <SourceIcon step={task.input} />
        {compact ? shortName(task.input) : task.input}
      </span>
      <span className={`bar ${jobColor(task.job)}`} style={{ "--from": run.from, "--to": task.progress } as CSSProperties}>
        <i className="bar-before" />
        <i className="bar-now" />
      </span>
      <span className="step-meta">
        {(!compact || !from) && <span>{Math.round(task.progress * 100)}%</span>}
        {from && <em>from {from}</em>}
      </span>
    </div>
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

function Crown() {
  return (
    <svg className="crown" viewBox="0 0 16 12" aria-label="Orchestrator" role="img">
      <path d="M1 10.5h14L13.6 3 10.4 6.4 8 1.5 5.6 6.4 2.4 3z" />
    </svg>
  );
}
