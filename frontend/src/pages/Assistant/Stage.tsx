import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon, IconTile } from "../../components/Icon";
import { boardName } from "../Cluster/cluster";
import type { ClusterState, Job, RaftNode, Task } from "../Cluster/cluster";
import { Dispatch, Preview } from "./Preview";
import { caption } from "./story";
import type { StoryEvent } from "./story";

// The cluster drawn for a person: the orchestrator on top, the other boards
// below, a soft line to each. Work goes down a line as a chip and results come
// back up as chips. When a board dies, the orchestrator notices, takes its step
// back, and sends it down another line like any other assignment.

const FLIGHT_MS = 1100;
const CARD_H = 252;
const ORCH_H = 172;

type Point = { x: number; y: number };
type Layout = { width: number; height: number; orchestrator: Point; cards: Map<string, Point & { w: number }> };

function layoutOf(width: number, ids: string[]): Layout {
  const phone = width < 640;
  const columns = phone ? 2 : Math.max(ids.length, 1);
  const gap = phone ? 10 : 14;
  const w = Math.min(220, (width - gap * (columns - 1)) / columns);
  const top = ORCH_H + (phone ? 56 : 76);
  const cards = new Map<string, Point & { w: number }>();
  ids.forEach((id, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, ids.length - row * columns);
    const offset = (width - (inRow * w + gap * (inRow - 1))) / 2;
    cards.set(id, { x: offset + (index % columns) * (w + gap) + w / 2, y: top + row * (CARD_H + 14), w });
  });
  const rows = Math.ceil(ids.length / columns);
  return { width, height: top + rows * (CARD_H + 14), orchestrator: { x: width / 2, y: 8 }, cards };
}

// A soft S-curve from the orchestrator's bottom to a card's top.
function curve(from: Point, to: Point): string {
  const mid = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y}`;
}

// Points along a cubic curve, for a chip to fly through.
function samples(from: Point, c1: Point, c2: Point, to: Point, count = 16): Point[] {
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    const u = 1 - t;
    return {
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
    };
  });
}

export function Stage({ job, tasks, cluster, events, now, act }: { job: Job; tasks: Task[]; cluster: ClusterState; events: StoryEvent[]; now: number; act: (path: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setWidth(ref.current.clientWidth || 900);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  const orchestrator = cluster.orchestrator;
  const workers = cluster.nodes.filter((node) => node.id !== orchestrator);
  const layout = layoutOf(width, workers.map((node) => node.id));
  const bottom = { x: layout.orchestrator.x, y: layout.orchestrator.y + ORCH_H };
  const top = (id: string) => {
    const card = layout.cards.get(id);
    return card ? { x: card.x, y: card.y } : null;
  };

  // Chips in the air: anything sent, returned or handed over in the last second or so.
  const flights = events.filter((event) => ["out", "back", "takeover"].includes(event.kind) && now - event.at < FLIGHT_MS + 300 && event.board && event.board !== orchestrator);

  return (
    <div className="stage" ref={ref} style={{ height: layout.height } as CSSProperties}>
      <svg className="wires" width={layout.width} height={layout.height} aria-hidden="true">
        {workers.map((node) => {
          const to = top(node.id);
          if (!to) return null;
          const busy = tasks.some((task) => task.status === "claimed" && task.worker === node.id);
          return <path key={node.id} d={curve(bottom, to)} className={!node.up ? "is-down" : busy ? "is-busy" : ""} />;
        })}
      </svg>

      <OrchestratorNode id={orchestrator} job={job} tasks={tasks} act={act} style={{ left: layout.orchestrator.x, top: layout.orchestrator.y }} />

      {workers.map((node) => {
        const card = layout.cards.get(node.id)!;
        return <WorkerNode key={node.id} node={node} job={job} tasks={tasks} cluster={cluster} act={act} style={{ left: card.x - card.w / 2, top: card.y, width: card.w }} />;
      })}

      {flights.map((event) => {
        const to = top(event.board!);
        if (!to) return null;
        // Every assignment comes from the orchestrator, a reassigned step included.
        const mid = (bottom.y + to.y) / 2;
        const path = samples(bottom, { x: bottom.x, y: mid }, { x: to.x, y: mid }, to);
        if (event.kind === "back") path.reverse();
        return <Flight key={event.key} event={event} path={path} />;
      })}
    </div>
  );
}

// A chip that flies along its path once, then fades.
function Flight({ event, path }: { event: StoryEvent; path: Point[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  // The path it was launched on; a later re-render must not restart the flight.
  const launched = useRef(path);
  useEffect(() => {
    const element = ref.current;
    const path = launched.current;
    if (!element || typeof element.animate !== "function") return;
    const frames = path.map((point, index) => ({ transform: `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`, opacity: index === 0 ? 0 : 1, offset: (index / (path.length - 1)) * 0.82 }));
    const last = path.at(-1)!;
    frames.push({ transform: `translate(${last.x}px, ${last.y}px) translate(-50%, -50%) scale(0.9)`, opacity: 0, offset: 1 });
    element.animate(frames, { duration: FLIGHT_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" });
  }, []);
  const task = event.task!;
  const start = path[0];
  const text = event.kind === "back" ? task.output?.short ?? "Done" : event.kind === "takeover" ? `${task.label ?? task.input} (was ${boardName(event.from!)}'s)` : task.label ?? task.input;
  return (
    <span ref={ref} className={`flight is-${event.kind}`} style={{ transform: `translate(${start.x}px, ${start.y}px) translate(-50%, -50%)` }} title={task.input}>
      {event.kind === "back" ? <Icon name="check" size={13} /> : <Icon name={task.icon ?? "doc"} size={13} />}
      {text}
    </span>
  );
}

function Kebab({ items }: { items: Array<{ label: string; kill?: boolean; onClick: () => void }> }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: PointerEvent) {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details className="kebab" ref={ref}>
      <summary className="kebab-button" aria-label="Board actions">
        <Icon name="more" size={16} />
      </summary>
      <div className="kebab-menu">
        {items.map((item) => (
          <button key={item.label} type="button" className={item.kill ? "is-kill" : ""} onClick={() => { ref.current!.open = false; item.onClick(); }}>
            {item.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function OrchestratorNode({ id, job, tasks, act, style }: { id: string | null; job: Job; tasks: Task[]; act: (path: string) => void; style: CSSProperties }) {
  const plan = job.plan!;
  const stageTasks = tasks.filter((task) => task.stage === plan.stage);
  const own = stageTasks.find((task) => task.role === "orchestrator");
  const back = stageTasks.filter((task) => task.status === "done");
  const results = tasks.filter((task) => task.status === "done" && task.role !== "orchestrator").sort((a, b) => (a.runs.at(-1)!.end ?? 0) - (b.runs.at(-1)!.end ?? 0));

  const previous = tasks.filter((task) => task.stage === plan.stage - 1);
  const pieces = own ? previous : stageTasks;

  if (!id) {
    return (
      <div className="node orchestrator is-electing" style={style} aria-label="Orchestrator">
        <div className="orchestrator-info">
          <div className="node-head">
            <Icon name="crown" size={16} className="crown" />
            <strong>Electing…</strong>
          </div>
          <p className="node-caption">Boards are voting for a new orchestrator</p>
          <p className="node-caption muted">The plan is saved on every board</p>
        </div>
        <Dispatch tasks={pieces} />
      </div>
    );
  }

  let activity: string;
  if (job.doneAt !== null) activity = plan.error ? "Stopped" : "Done";
  else if (own) activity = own.status === "claimed" ? `${own.label ?? "Merging"} · ${Math.round(own.progress * 100)}%` : `Next: ${own.label ?? "merge the results"}`;
  else activity = `Split into ${stageTasks.length} · ${back.length} back`;

  return (
    <div className="node orchestrator" style={style} aria-label="Orchestrator" title={own?.input}>
      <div className="orchestrator-info">
        <div className="node-head">
          <span key={id} className="crown-pop"><Icon name="crown" size={16} className="crown" /></span>
          <strong>{boardName(id)}</strong>
          <span className="node-role">Orchestrator</span>
          <Kebab items={[{ label: "Kill orchestrator", kill: true, onClick: () => act(`/api/cluster/nodes/${id}/kill`) }]} />
        </div>
        <p className="node-caption">{activity}</p>
        {own?.status === "claimed" && <span className="thin-bar"><i style={{ width: `${own.progress * 100}%` }} /></span>}
        <p className="results-count">
          <strong>{results.length}</strong> {results.length === 1 ? "result" : "results"} collected
        </p>
      </div>
      <Dispatch tasks={pieces} />
    </div>
  );
}

function WorkerNode({ node, job, tasks, cluster, act, style }: { node: RaftNode; job: Job; tasks: Task[]; cluster: ClusterState; act: (path: string) => void; style: CSSProperties }) {
  const current = tasks.find((task) => task.status === "claimed" && task.worker === node.id) ?? cluster.tasks.find((task) => task.status === "claimed" && task.worker === node.id);
  const lost = tasks.filter((task) => task.lostBy.includes(node.id)).at(-1);
  const last = tasks.filter((task) => task.status === "done" && task.runs.at(-1)?.worker === node.id).sort((a, b) => (b.runs.at(-1)!.end ?? 0) - (a.runs.at(-1)!.end ?? 0))[0];
  const dead = !node.up;
  const voting = node.up && node.role === "candidate";
  // A dead board still holding a step has not been noticed yet; the orchestrator still counts the step as its.
  const silent = dead ? tasks.find((task) => task.status === "claimed" && task.worker === node.id) : undefined;
  const status = silent ? "No response" : dead ? "Down" : voting ? "Voting" : current ? "Working" : "Idle";
  const mine = current?.job === job.id;
  // The board that led the last term, now down: its crown went to whoever was elected after it.
  // Only an orchestrator lost during this job counts, not one replaced while the cluster was starting.
  const terms = cluster.terms;
  const replacedDuringJob = cluster.orchestrator ? terms.at(-1)!.at > job.queuedAt && terms.at(-2)?.orchestrator === node.id : terms.at(-1)?.orchestrator === node.id;
  const wasOrchestrator = dead && replacedDuringJob;

  return (
    <div className={`node worker is-${dead ? "down" : status.toLowerCase()}`} style={style} role="group" aria-label={boardName(node.id)} title={current?.input ?? lost?.input ?? ""}>
      <div className="node-head">
        <span className={`dot ${dead ? "tone-bad" : current ? "tone-busy" : voting ? "tone-warn" : ""}`} aria-hidden="true" />
        <strong>{boardName(node.id)}</strong>
        {dead ? (
          node.member ? <button className="button small restart" type="button" onClick={() => act(`/api/cluster/nodes/${node.id}/start`)}>Restart</button> : <span className="badge is-bad">{status}</span>
        ) : (
          <span className={`badge ${current ? "is-ok" : voting ? "is-warn" : ""}`}>{status}</span>
        )}
        {!dead && (
          <Kebab items={[{ label: "Kill board", kill: true, onClick: () => act(`/api/cluster/nodes/${node.id}/kill`) }]} />
        )}
      </div>
      {dead ? (
        <>
          <div className="holding is-lost">
            <span className="x-mark"><Icon name="x" size={14} /></span>
            <span>{wasOrchestrator ? "Orchestrator" : (silent ?? lost)?.label ?? "Powered off"}</span>
          </div>
          <p className={`node-caption ${silent ? "is-warn" : "is-bad"}`}>{wasOrchestrator ? (cluster.orchestrator ? `Down · ${boardName(cluster.orchestrator)} took over the plan` : "Down · others are electing") : silent ? "No response · not noticed yet" : lost ? (lost.status === "queued" ? "Down · orchestrator took it back" : `Down · given to ${boardName(lost.runs.at(-1)!.worker)}`) : "Down"}</p>
          {(silent ?? lost) && <Preview task={(silent ?? lost)!} progress={silent ? silent.progress : lost!.runs.find((run) => run.worker === node.id && run.outcome === "lost")?.to ?? 0} frozen />}
        </>
      ) : current ? (
        <>
          <div className="holding">
            <IconTile name={mine ? current.icon ?? "doc" : "list"} size={14} />
            <span>{mine ? current.label ?? current.input : `Today: ${current.input.replace(/^Fetch /, "")}`}</span>
          </div>
          <p className="node-caption">{mine ? caption(current) : `Refreshing · ${Math.round(current.progress * 100)}%`}</p>
          <span className="thin-bar"><i style={{ width: `${current.progress * 100}%` }} /></span>
          {mine && <Preview task={current} progress={current.progress} />}
        </>
      ) : (
        <>
          <div className="holding is-idle">
            <span className="idle-ring" />
            <span>{last ? `Sent ${last.output?.short ?? "result"}` : "Waiting for work"}</span>
          </div>
          <p className="node-caption">{last ? last.label : "Idle"}</p>
          {last && <Preview task={last} progress={1} />}
        </>
      )}
    </div>
  );
}
