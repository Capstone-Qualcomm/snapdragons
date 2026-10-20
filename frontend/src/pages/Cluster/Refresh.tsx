import type { CSSProperties } from "react";
import { jobColor, seconds } from "./cluster";
import type { ClusterState, Job, Task } from "./cluster";
import { SourceIcon } from "./Boards";

// The current refresh as it comes together: each source is fetched on some
// node, then one node ranks the results into Today's list.
export function LatestRefresh({ cluster, now }: { cluster: ClusterState; now: number }) {
  // The one the nodes are working on, or the last one to finish.
  const job = cluster.jobs.find((candidate) => candidate.doneAt === null) ?? cluster.jobs.at(-1);
  if (!job) return <section className="refresh panel-box" aria-label="Latest refresh" />;
  const steps = cluster.tasks.filter((task) => task.job === job.id);
  return (
    <section className={`refresh panel-box ${jobColor(job.id)}`} aria-label="Latest refresh">
      <header className="box-head">
        <h2>
          {job.id} {job.name}
        </h2>
        <span className="box-value">{seconds((job.doneAt ?? now) - job.queuedAt)}</span>
      </header>
      <ol className="refresh-steps">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ol>
    </section>
  );
}

function StepRow({ step }: { step: Task }) {
  const run = step.runs.at(-1);
  return (
    <li className={`refresh-step is-${step.status}`}>
      <SourceIcon step={step.input} />
      <span className="refresh-name">{step.input}</span>
      <span className="refresh-nodes">
        {step.lostBy.map((node, index) => (
          <s key={index}>{node}</s>
        ))}
        {step.worker && <span>{step.worker}</span>}
      </span>
      <span className="refresh-bar">
        <i style={{ width: `${step.progress * 100}%` }} />
      </span>
      <span className="refresh-time">{run?.end && step.status === "done" ? seconds(run.end - step.runs[0].start) : ""}</span>
    </li>
  );
}

// Average time from queuing a refresh to its ranked list, by how many nodes ran
// its steps: one column per node count, so more nodes reads as shorter bars.
export function RefreshTimes({ jobs, members, maxNodes }: { jobs: Job[]; members: number; maxNodes: number }) {
  const byNodes = new Map<number, number[]>();
  for (const job of jobs) {
    if (job.doneAt !== null && job.nodes) byNodes.set(job.nodes, [...(byNodes.get(job.nodes) ?? []), job.doneAt - job.queuedAt]);
  }
  const average = (times: number[]) => times.reduce((sum, time) => sum + time, 0) / times.length;
  const longest = Math.max(...[...byNodes.values()].map(average), 1);

  return (
    <section className="times panel-box" aria-label="Refresh time by node count">
      <header className="box-head">
        <h2>Refresh time</h2>
      </header>
      <ol className="times-chart">
        {Array.from({ length: maxNodes }, (_, index) => {
          const nodes = index + 1;
          const times = byNodes.get(nodes);
          return (
            <li key={nodes} className={nodes === members ? "is-current" : ""}>
              {times && <span className="times-value">{seconds(average(times))}</span>}
              <span className="times-bar" style={{ "--h": times ? average(times) / longest : 0 } as CSSProperties}>
                {times && <i />}
              </span>
              <span className="times-nodes">{nodes === 1 ? "1 node" : `${nodes} nodes`}</span>
              {times && <span className="times-count">×{times.length}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
