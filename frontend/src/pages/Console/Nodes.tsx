import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { appPath } from "../../lib/urls";
import { jobColor, shortName, sourceOf } from "./cluster";
import type { ClusterState, QueueWorker, RaftNode, Task } from "./cluster";

// How far back the timeline goes.
const WINDOW_MS = 45_000;
const TICKS = [45, 30, 15, 0];

type Actions = { act: (path: string, body?: unknown) => void };

// The cluster as one row per board: what it is in Raft, what it is working on,
// and its last minute of work. Steps lost by a dead node are joined by a dashed
// line to where another node picked them up.
export function Nodes({ cluster, serverNow, act }: { cluster: ClusterState; serverNow: () => number } & Actions) {
  const now = useClock(serverNow);
  const start = now - WINDOW_MS;
  // A node that left keeps its row while its work is still on the timeline.
  const recent = cluster.tasks.flatMap((task) => task.runs.filter((run) => (run.end ?? now) >= start).map((run) => run.worker));
  const gone = [...new Set(recent)].filter((id) => !cluster.nodes.some((node) => node.id === id)).map((id): RaftNode => ({ id, up: false, member: false }));
  const nodes = [...cluster.nodes, ...gone].sort((a, b) => a.id.localeCompare(b.id));
  const lane = new Map(nodes.map((node, index) => [node.id, index]));
  const x = (time: number) => ((Math.max(time, start) - start) / WINDOW_MS) * 100;

  return (
    <section className="nodes" aria-label="Nodes">
      <QueueRow cluster={cluster} />
      <div className="node-table" style={{ "--rows": Math.max(nodes.length, 1) } as CSSProperties}>
        <div className="node-info">
          {nodes.map((node) => (
            <NodeRow key={node.id} node={node} cluster={cluster} act={act} />
          ))}
        </div>
        <div className="lanes">
          {nodes.map((node) => (
            <div className="lane" key={node.id}>
              <span className="lane-name">{node.id}</span>
              {cluster.tasks.flatMap((task) =>
                task.runs.map((run, index) => {
                  const end = run.end ?? now;
                  if (run.worker !== node.id || end < start) return null;
                  return (
                    <span
                      key={`${task.id}-${index}`}
                      className={`block ${jobColor(task.job)} is-${run.outcome}`}
                      style={{ left: `${x(run.start)}%`, width: `${Math.max(x(end) - x(run.start), 0.3)}%` }}
                      title={`${task.id} ${task.input}`}
                    >
                      <SourceIcon step={task.input} />
                    </span>
                  );
                }),
              )}
            </div>
          ))}
          <svg className="handoffs" viewBox={`0 0 100 ${nodes.length}`} preserveAspectRatio="none" aria-hidden="true">
            {cluster.terms.filter((term) => term.at >= start).map((term) => (
              <line key={term.term} className="term-line" x1={x(term.at)} x2={x(term.at)} y1={0} y2={nodes.length} />
            ))}
            {cluster.tasks.flatMap((task) =>
              task.runs.slice(0, -1).map((run, index) => {
                const next = task.runs[index + 1];
                const from = lane.get(run.worker);
                const to = lane.get(next.worker);
                if (run.outcome !== "lost" || from === undefined || to === undefined || (run.end ?? 0) < start) return null;
                return <line key={`${task.id}-${index}`} className="handoff" x1={x(run.end!)} y1={from + 0.5} x2={x(next.start)} y2={to + 0.5} />;
              }),
            )}
          </svg>
          {cluster.terms.filter((term) => term.at >= start).map((term) => (
            <span key={term.term} className="term-mark" style={{ left: `${x(term.at)}%` }}>
              term {term.term}
            </span>
          ))}
        </div>
        <div className="axis">
          {TICKS.map((tick) => (
            <span key={tick} style={{ left: `${100 - (tick / 45) * 100}%` }}>{tick ? `${tick} s` : "now"}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

// Re-renders a few times a second so blocks grow and slide between polls.
function useClock(serverNow: () => number) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 200);
    return () => clearInterval(timer);
  }, [serverNow]);
  return now;
}

function QueueRow({ cluster }: { cluster: ClusterState }) {
  const waiting = cluster.tasks.filter((task) => task.status === "queued");
  const done = new Set(cluster.tasks.filter((task) => task.status === "done").map((task) => task.id));
  return (
    <div className="queue-row">
      <span className="queue-name">Queue</span>
      <span className="queue-count">{waiting.length}</span>
      <div className="queue-chips">
        {waiting.map((task) => (
          <span key={task.id} className={`step-chip ${jobColor(task.job)}${task.after.some((id) => !done.has(id)) ? " is-blocked" : ""}`}>
            <SourceIcon step={task.input} />
            {shortName(task.input)}
            {task.progress > 0 && <span className="chip-progress">{Math.round(task.progress * 100)}%</span>}
          </span>
        ))}
      </div>
      {!cluster.orchestrator && cluster.nodes.some((node) => node.up) && <span className="queue-alert">No orchestrator</span>}
    </div>
  );
}

function NodeRow({ node, cluster, act }: { node: RaftNode; cluster: ClusterState } & Actions) {
  const worker: QueueWorker | undefined = cluster.workers.find((candidate) => candidate.id === node.id);
  const task = cluster.tasks.find((candidate) => candidate.status === "claimed" && candidate.worker === node.id);
  const isOrchestrator = node.id === cluster.orchestrator;
  const state = !node.up ? (node.member ? "dead" : "left") : !node.member ? "joining" : worker?.leaving ? "leaving" : task ? "working" : "idle";
  const path = (action: string) => `/api/cluster/nodes/${node.id}/${action}`;

  return (
    <div className={`node-row is-${state}${isOrchestrator ? " is-orchestrator" : ""}`} role="group" aria-label={node.id}>
      <div className="node-name">
        <span className={`dot ${tone[state]}`} aria-hidden="true" />
        <strong>{node.id}</strong>
        {isOrchestrator && <Crown />}
      </div>
      <div className="node-role">
        {node.up ? <RoleCell node={node} isOrchestrator={isOrchestrator} leaving={state === "leaving"} waiting={!cluster.orchestrator} /> : state === "dead" ? <span className="is-dead-text">Dead</span> : <span className="node-state">Left</span>}
      </div>
      <div className="node-step">
        {task ? <StepProgress key={task.id} task={task} /> : <span className="node-state">{stateLabel[state]}</span>}
      </div>
      <div className="node-log">
        {node.up && (
          <>
            <span>log {node.lastIndex}</span>
            <span>commit {node.commitIndex}</span>
          </>
        )}
      </div>
      <div className="node-actions">
        {state === "dead" && <button className="button small" type="button" onClick={() => act(path("start"))}>Restart</button>}
        {(state === "dead" || (node.up && !worker?.leaving)) && <button className="button small" type="button" onClick={() => act(path("remove"))}>Remove</button>}
        {node.up && <button className="button small is-kill" type="button" onClick={() => act(path("kill"))}>Kill</button>}
      </div>
    </div>
  );
}

const tone: Record<string, string> = {
  dead: "tone-bad",
  left: "tone-off",
  joining: "tone-warn",
  leaving: "tone-warn",
  working: "tone-busy",
  idle: "tone-ok",
};

const stateLabel: Record<string, string> = {
  dead: "",
  left: "",
  joining: "Joining",
  leaving: "Leaving",
  working: "",
  idle: "Idle",
};

// While there is no orchestrator, each worker counts down its own random
// timeout; the first to reach zero asks the others for their votes.
function RoleCell({ node, isOrchestrator, leaving, waiting }: { node: RaftNode; isOrchestrator: boolean; leaving: boolean; waiting: boolean }) {
  const needed = Math.floor((node.members?.length ?? 0) / 2) + 1;
  const role = node.role === "candidate" ? "Candidate" : isOrchestrator ? "Orchestrator" : leaving ? "Leaving" : "Worker";
  return (
    <>
      <span className={`role is-${role.toLowerCase()}`}>{role}</span>
      <span className="term">term {node.term}</span>
      {waiting && node.role === "worker" && node.member && <span className="election-in">election in {((node.electionIn ?? 0) / 1000).toFixed(1)} s</span>}
      {node.role === "candidate" && (
        <span className="votes" aria-label={`${node.votes?.length ?? 0} of ${needed} votes`}>
          {Array.from({ length: needed }, (_, index) => <i key={index} className={index < (node.votes?.length ?? 0) ? "is-in" : ""} />)}
        </span>
      )}
    </>
  );
}

// The bar starts where the step's last checkpoint was, so a step handed over
// from a dead node visibly carries on instead of starting again.
function StepProgress({ task }: { task: Task }) {
  const run = task.runs.at(-1)!;
  const from = task.lostBy.at(-1);
  return (
    <div className="step-progress">
      <span className="step-title">
        <SourceIcon step={task.input} />
        {task.input}
      </span>
      <span className={`bar ${jobColor(task.job)}`}>
        <i className="bar-before" style={{ width: `${run.from * 100}%` }} />
        <i className="bar-now" style={{ left: `${run.from * 100}%`, width: `${(task.progress - run.from) * 100}%` }} />
      </span>
      <span className="step-meta">
        {Math.round(task.progress * 100)}%{from && <em> from {from}</em>}
      </span>
    </div>
  );
}

export function SourceIcon({ step }: { step: string }) {
  const source = sourceOf(step);
  return source ? <img className={`logo logo-${source}`} src={appPath(`${source}-logo.png`)} alt="" /> : <span className="logo logo-rank" aria-hidden="true" />;
}

function Crown() {
  return (
    <svg className="crown" viewBox="0 0 16 12" aria-label="Orchestrator" role="img">
      <path d="M1 10.5h14L13.6 3 10.4 6.4 8 1.5 5.6 6.4 2.4 3z" />
    </svg>
  );
}
