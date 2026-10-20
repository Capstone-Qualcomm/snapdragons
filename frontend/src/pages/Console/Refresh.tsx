import { appPath } from "../../lib/urls";
import { jobColor, seconds } from "./cluster";
import type { ClusterState, Job, Task } from "./cluster";
import { SourceIcon } from "./Nodes";

// The newest refresh as it comes together: each source is fetched on some
// node, then one node ranks the results into the list the Report shows.
export function LatestRefresh({ cluster, now }: { cluster: ClusterState; now: number }) {
  const job = cluster.jobs.at(-1);
  if (!job) return null;
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
      {job.doneAt !== null && (
        <a className="button refresh-open" href={appPath("report")}>
          Open Report
        </a>
      )}
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
        {step.lostBy.map((node) => (
          <s key={node}>{node}</s>
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
// its steps. With more nodes, more of the six fetches run at the same time.
export function RefreshTimes({ jobs, members }: { jobs: Job[]; members: number }) {
  const finished = jobs.filter((job) => job.doneAt !== null && job.nodes);
  const byNodes = new Map<number, number[]>();
  for (const job of finished) byNodes.set(job.nodes!, [...(byNodes.get(job.nodes!) ?? []), job.doneAt! - job.queuedAt]);
  const rows = [...byNodes].sort(([a], [b]) => a - b).map(([nodes, times]) => ({ nodes, average: times.reduce((sum, time) => sum + time, 0) / times.length, count: times.length }));
  const longest = Math.max(...rows.map((row) => row.average), 1);

  return (
    <section className="times panel-box" aria-label="Refresh time by node count">
      <header className="box-head">
        <h2>Refresh time</h2>
      </header>
      <ul className="times-rows">
        {rows.map((row) => (
          <li key={row.nodes} className={row.nodes === members ? "is-current" : ""}>
            <span className="times-nodes">{row.nodes === 1 ? "1 node" : `${row.nodes} nodes`}</span>
            <span className="times-bar">
              <i style={{ width: `${(row.average / longest) * 100}%` }} />
            </span>
            <span className="times-value">{seconds(row.average)}</span>
            <span className="times-count">×{row.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
