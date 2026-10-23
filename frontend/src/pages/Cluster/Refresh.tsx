import type { CSSProperties } from "react";
import type { Job } from "./cluster";

const SHOWN = 20;

// A clean top for the y axis: 2, 5 or 10 times a power of ten, at or above the slowest refresh.
function niceMax(value: number) {
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((factor) => factor * step).find((top) => top >= value) ?? value;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

// How long each of the last 20 refreshes took, oldest to newest: one column per
// refresh, seconds up the side, the time it finished along the bottom. The
// newest column is in the accent and carries its value.
export function RefreshChart({ jobs, offset }: { jobs: Job[]; offset: number }) {
  const finished = jobs.filter((job) => job.doneAt !== null).slice(-SHOWN);
  const times = finished.map((job) => (job.doneAt! - job.queuedAt) / 1000);
  const top = times.length ? niceMax(Math.max(...times)) : 0;
  const average = times.reduce((sum, time) => sum + time, 0) / (times.length || 1);
  // Gateway times, shown in this browser's clock.
  const at = (job: Job) => job.doneAt! - offset;

  return (
    <section className="panel refresh-panel" aria-labelledby="refresh-title">
      <header className="panel-head">
        <h2 id="refresh-title">Refresh time</h2>
        {times.length > 0 && <span className="panel-meta">Average <b className="num">{average.toFixed(1)} s</b> · last {times.length} {times.length === 1 ? "refresh" : "refreshes"}</span>}
      </header>
      {times.length === 0 ? (
        <p className="panel-empty">No refresh has finished yet.</p>
      ) : (
        <figure className="column-chart" aria-label={`Seconds per refresh, last ${times.length}`}>
          <span className="axis-title">Seconds</span>
          <div className="y-ticks" aria-hidden="true">
            {[top, top / 2, 0].map((tick) => <span key={tick}>{tick % 1 ? tick.toFixed(1) : tick}</span>)}
          </div>
          <ol className="plot">
            {finished.map((job, index) => {
              const last = index === finished.length - 1;
              return (
                <li key={job.id} className={last ? "is-latest" : ""} tabIndex={0} title={`${times[index].toFixed(1)} s on ${job.nodes ?? "?"} ${job.nodes === 1 ? "board" : "boards"}, finished ${clock(at(job))}`} style={{ "--h": times[index] / top } as CSSProperties}>
                  {last && <span className="column-value num">{times[index].toFixed(1)} s</span>}
                  <i />
                  <span className="sr-only">{times[index].toFixed(1)} seconds on {job.nodes} boards</span>
                </li>
              );
            })}
          </ol>
          <div className="x-ticks" aria-hidden="true">
            <span>{clock(at(finished[0]))}</span>
            {finished.length > 1 && <span>{clock(at(finished.at(-1)!))}</span>}
          </div>
          <figcaption className="axis-title x-title">Finished at</figcaption>
        </figure>
      )}
    </section>
  );
}
