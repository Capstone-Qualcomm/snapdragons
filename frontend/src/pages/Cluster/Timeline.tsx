import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ClusterState } from "./cluster";
import { SourceIcon } from "./Boards";

// How far back the timeline goes.
const WINDOW_MS = 45_000;
const TICKS = [45, 30, 15, 0];

// The last 45 seconds, one lane per board. A step lost by a dead node is cut
// off where it died and joined by a dashed line to where another node carried
// on; a dotted line marks each new orchestrator's term.
export function Timeline({ cluster, serverNow }: { cluster: ClusterState; serverNow: () => number }) {
  const now = useClock(serverNow);
  const start = now - WINDOW_MS;
  // A node that left keeps its lane while its work is still on the timeline.
  const recent = cluster.tasks.flatMap((task) => task.runs.filter((run) => (run.end ?? now) >= start).map((run) => run.worker));
  const ids = [...new Set([...cluster.nodes.map((node) => node.id), ...recent])].sort();
  const lane = new Map(ids.map((id, index) => [id, index]));
  const x = (time: number) => ((Math.max(time, start) - start) / WINDOW_MS) * 100;
  const terms = cluster.terms.filter((term) => term.at >= start);

  return (
    <section className="timeline" aria-label="Timeline" style={{ "--rows": Math.max(ids.length, 1) } as CSSProperties}>
      <div className="lane-names" aria-hidden="true">
        {ids.map((id) => <span key={id}>{id}</span>)}
      </div>
      <div className="lanes">
        {ids.map((id) => (
          <div className="lane" key={id}>
            {cluster.tasks.flatMap((task) =>
              task.runs.map((run, index) => {
                const end = run.end ?? now;
                if (run.worker !== id || end < start) return null;
                return (
                  <span
                    key={`${task.id}-${index}`}
                    className={`run is-${run.outcome}`}
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
        <svg className="handoffs" viewBox={`0 0 100 ${ids.length}`} preserveAspectRatio="none" aria-hidden="true">
          {terms.map((term) => (
            <line key={term.term} className="term-line" x1={x(term.at)} x2={x(term.at)} y1={0} y2={ids.length} />
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
        {terms.map((term) => (
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
