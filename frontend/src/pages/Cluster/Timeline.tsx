import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { boardName, seconds, shortName } from "./cluster";
import type { ClusterState, Task } from "./cluster";

const labelOf = (task: Task) => (task.skill ? task.skill[0].toUpperCase() + task.skill.slice(1) : shortName(task.input));
import { SourceIcon } from "./Boards";

// How far back the timeline goes.
const WINDOW_MS = 45_000;
const TICKS = [45, 30, 15, 0];

// The last 45 seconds, one lane per board, with a key to read it by. A step
// lost by a dead board is cut off where it died and joined by a dashed line to
// where another board carried on; a dotted line marks each election.
export function Timeline({ cluster, serverNow }: { cluster: ClusterState; serverNow: () => number }) {
  const now = useClock(serverNow);
  const start = now - WINDOW_MS;
  // A node that left keeps its lane while its work is still on the timeline.
  const recent = cluster.tasks.flatMap((task) => task.runs.filter((run) => (run.end ?? now) >= start).map((run) => run.worker));
  const ids = [...new Set([...cluster.nodes.map((node) => node.id), ...recent])].sort();
  const lane = new Map(ids.map((id, index) => [id, index]));
  const x = (time: number) => ((Math.max(time, start) - start) / WINDOW_MS) * 100;
  const terms = cluster.terms.filter((term) => term.at >= start);
  const width = useWidth();
  // A block's name is drawn only when it fits whole beside the icon (about 7 px a letter plus the icon).
  const fits = (from: number, to: number, name: string) => ((x(to) - x(from)) / 100) * width.value >= name.length * 7 + 34;

  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title">
      <header className="panel-head">
        <h2 id="timeline-title">Board activity</h2>
        <span className="panel-meta">Last 45 seconds, one row per board</span>
        <ul className="legend" aria-label="Key">
          <li><i className="key-running" />Working now</li>
          <li><i className="key-done" />Step done</li>
          <li><i className="key-lost" />Cut off when the board died</li>
          <li><i className="key-handoff" />Moved to another board</li>
          <li><i className="key-term" />Orchestrator elected</li>
          <li><SourceIcon step="Rank today's list" />Ranking step</li>
        </ul>
      </header>
      <div className="timeline" role="region" aria-label="Timeline" style={{ "--rows": Math.max(ids.length, 1) } as CSSProperties}>
        <div className="lane-names" aria-hidden="true">
          {ids.map((id) => <span key={id}>{boardName(id)}</span>)}
        </div>
        <div className="lanes" ref={width.ref}>
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
                      title={`${boardName(run.worker)}: ${task.input}${run.end ? `, ${seconds(run.end - run.start)}` : ""}${run.outcome === "lost" ? ", lost when the board died" : ""}`}
                    >
                      {/* An Assistant step is named by its skill; a refresh step by its source's logo and name. */}
                      {!task.skill && <SourceIcon step={task.input} />}
                      {/* The name only where it fits; the tooltip carries it otherwise. */}
                      {fits(run.start, end, labelOf(task)) && <span className="run-name">{labelOf(task)}</span>}
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
            <span key={term.term} className={x(term.at) > 80 ? "term-mark is-right" : "term-mark"} style={{ left: `${x(term.at)}%` }}>
              {boardName(term.orchestrator)} elected
            </span>
          ))}
        </div>
        <div className="axis">
          {TICKS.map((tick) => (
            <span key={tick} style={{ left: `${100 - (tick / 45) * 100}%` }}>{tick ? `${tick} s ago` : "now"}</span>
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

// The lanes' width in pixels, kept current as the window resizes.
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setValue(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, value };
}
