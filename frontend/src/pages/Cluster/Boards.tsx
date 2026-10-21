import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { appPath } from "../../lib/urls";
import "./Boards.css";
import { shortName, sourceOf } from "./cluster";
import type { ClusterState, RaftNode, Task } from "./cluster";

type BoardState = "dead" | "left" | "joining" | "leaving" | "working" | "idle";

// What one board is doing right now, from the gateway's state.
function boardOf(node: RaftNode, cluster: ClusterState) {
  const worker = cluster.workers.find((candidate) => candidate.id === node.id);
  const task = cluster.tasks.find((candidate) => candidate.status === "claimed" && candidate.worker === node.id);
  const state: BoardState = !node.up ? (node.member ? "dead" : "left") : !node.member ? "joining" : worker?.leaving ? "leaving" : task ? "working" : "idle";
  return { task, state, leaving: Boolean(worker?.leaving), isOrchestrator: node.id === cluster.orchestrator };
}

const led: Record<BoardState, string> = { dead: "tone-bad", left: "tone-off", joining: "tone-warn", leaving: "tone-warn", working: "tone-busy", idle: "" };

type Act = (path: string, body?: unknown) => void;

// The rack: one board per node and, while there is room, a tile that adds one.
// A board shows its name, the crown if it is orchestrator, and its step;
// clicking it opens its Raft numbers and controls.
export function Rack({ cluster, act }: { cluster: ClusterState; act: Act }) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!(event.target as Element).closest?.(".board")) setOpen(null);
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <ul className="rack" aria-label="Nodes">
      {cluster.nodes.map((node) => (
        <Board
          key={node.id}
          node={node}
          cluster={cluster}
          open={open === node.id}
          onToggle={() => setOpen(open === node.id ? null : node.id)}
          act={(path) => {
            setOpen(null);
            act(path);
          }}
        />
      ))}
      {cluster.nodes.length < cluster.maxNodes && (
        <li className="slot">
          <button className="slot-add" type="button" onClick={() => act("/api/cluster/nodes")}>
            <span aria-hidden="true">+</span>Add node
          </button>
        </li>
      )}
    </ul>
  );
}

function Board({ node, cluster, open, onToggle, act }: { node: RaftNode; cluster: ClusterState; open: boolean; onToggle: () => void; act: Act }) {
  const { task, state, leaving, isOrchestrator } = boardOf(node, cluster);
  const path = (action: string) => `/api/cluster/nodes/${node.id}/${action}`;
  const needed = Math.floor((node.members?.length ?? 0) / 2) + 1;
  const role = !node.up ? (state === "dead" ? "Dead" : "Left") : node.role === "candidate" ? "Candidate" : isOrchestrator ? "Orchestrator" : leaving ? "Leaving" : state === "joining" ? "Joining" : "Worker";
  // While there is no orchestrator, each worker counts down its own random
  // timeout; the first to reach zero asks the others for their votes.
  const electing = node.up && node.member && !cluster.orchestrator;

  return (
    <li className={`board is-${state}${isOrchestrator ? " is-orchestrator" : ""}${open ? " is-open" : ""}`} role="group" aria-label={node.id}>
      <button className="board-face" type="button" aria-expanded={open} onClick={onToggle}>
        <span className="board-head">
          <span className={`dot ${led[state]}`} aria-hidden="true" />
          <strong>{node.id}</strong>
          {isOrchestrator && <Crown />}
          {electing && node.role === "worker" && <Countdown ms={node.electionIn ?? 0} />}
          {node.role === "candidate" && node.up && (
            <span className="votes" role="img" aria-label={`${node.votes?.length ?? 0} of ${needed} votes`}>
              {Array.from({ length: needed }, (_, index) => <i key={index} className={index < (node.votes?.length ?? 0) ? "is-in" : ""} />)}
            </span>
          )}
        </span>
        <Work task={task} node={node} cluster={cluster} />
      </button>

      {open && (
        <div className="board-menu">
          <p className={`role is-${role.toLowerCase()}`}>{role}</p>
          {node.up && (
            <p className="board-raft">
              <span>term {node.term}</span>
              <span>log {node.lastIndex}</span>
              <span>commit {node.commitIndex}</span>
            </p>
          )}
          <div className="board-actions">
            {state === "dead" && <button className="button small" type="button" onClick={() => act(path("start"))}>Restart</button>}
            {(state === "dead" || (node.up && !leaving)) && <button className="button small" type="button" onClick={() => act(path("remove"))}>Remove</button>}
            {node.up && <button className="button small is-kill" type="button" onClick={() => act(path("kill"))}>Kill</button>}
          </div>
        </div>
      )}
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
            <span className="board-head">
              <span className={`dot ${led[state]}`} aria-hidden="true" />
              <strong>{node.id}</strong>
              {isOrchestrator && <Crown />}
            </span>
            <Work task={task} node={node} cluster={cluster} />
          </li>
        );
      })}
    </ul>
  );
}

// A board's step with its progress; between refreshes, the step it finished
// last; nothing for a board that has not run one or is down.
function Work({ task, node, cluster }: { task?: Task; node: RaftNode; cluster: ClusterState }) {
  if (task) return <StepProgress key={task.id} task={task} />;
  const last = node.up ? lastDone(node.id, cluster) : undefined;
  if (!last) return <span className="work-none" aria-hidden="true" />;
  return (
    <span className="work-last" title={last.input}>
      <SourceIcon step={last.input} />
      {shortName(last.input)}
      <svg className="check" viewBox="0 0 16 16" aria-label="Done" role="img"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>
    </span>
  );
}

function lastDone(id: string, cluster: ClusterState): Task | undefined {
  let last: Task | undefined;
  for (const task of cluster.tasks) {
    const run = task.runs.at(-1);
    if (task.status === "done" && run?.worker === id && (!last || (run.end ?? 0) > (last.runs.at(-1)!.end ?? 0))) last = task;
  }
  return last;
}

// The bar starts where the step's last checkpoint was, so a step handed over
// from a dead node visibly carries on instead of starting again.
function StepProgress({ task }: { task: Task }) {
  const run = task.runs.at(-1)!;
  const from = task.lostBy.at(-1);
  return (
    <span className="step-progress" title={task.input}>
      <span className="step-title">
        <SourceIcon step={task.input} />
        <span className="step-name">{shortName(task.input)}</span>
        <span className="step-meta">{from ? <em>from {from}</em> : `${Math.round(task.progress * 100)}%`}</span>
      </span>
      <span className="bar" style={{ "--from": run.from, "--to": task.progress } as CSSProperties}>
        <i className="bar-before" />
        <i className="bar-now" />
      </span>
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

// A ring that empties as the worker's election timeout runs out (3 s at most).
function Countdown({ ms }: { ms: number }) {
  const left = Math.min(ms / 3000, 1);
  return (
    <svg className="countdown" viewBox="0 0 16 16" role="img" aria-label={`election in ${(ms / 1000).toFixed(1)} s`}>
      <circle cx="8" cy="8" r="6" pathLength="1" strokeDasharray={`${left} 1`} />
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
